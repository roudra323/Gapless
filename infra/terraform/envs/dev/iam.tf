# IAM (docs/07): the roles that EKS and its nodes use, the role CI uses to deploy (GitHub OIDC, no
# stored keys), and one role per add-on that calls AWS from a Pod (EKS Pod Identity).

data "aws_partition" "current" {}

locals {
  managed_policy = "arn:${data.aws_partition.current.partition}:iam::aws:policy"
}

# --- EKS control plane ---------------------------------------------------------------------------

data "aws_iam_policy_document" "eks_assume" {
  statement {
    actions = ["sts:AssumeRole", "sts:TagSession"]
    principals {
      type        = "Service"
      identifiers = ["eks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "cluster" {
  name               = "${local.name}-cluster"
  assume_role_policy = data.aws_iam_policy_document.eks_assume.json
}

resource "aws_iam_role_policy_attachment" "cluster" {
  role       = aws_iam_role.cluster.name
  policy_arn = "${local.managed_policy}/AmazonEKSClusterPolicy"
}

# --- Worker nodes --------------------------------------------------------------------------------

data "aws_iam_policy_document" "ec2_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "node" {
  name               = "${local.name}-node"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
}

# Join the cluster, run the VPC CNI (Pod IPs), and pull images from ECR.
resource "aws_iam_role_policy_attachment" "node" {
  for_each = toset([
    "AmazonEKSWorkerNodePolicy",
    "AmazonEKS_CNI_Policy",
    "AmazonEC2ContainerRegistryReadOnly",
  ])

  role       = aws_iam_role.node.name
  policy_arn = "${local.managed_policy}/${each.value}"
}

# --- GitHub Actions deployer (OIDC) --------------------------------------------------------------

# GitHub's OIDC issuer. A workflow gets a short-lived token from it and trades it for AWS
# credentials, so no AWS key is stored in GitHub (docs/04 bans long-lived keys).
resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

# Only workflows of this repository, on refs/heads/main, can assume the role (docs/07).
data "aws_iam_policy_document" "deployer_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repository}:ref:refs/heads/main"]
    }
  }
}

resource "aws_iam_role" "deployer" {
  name                 = "${local.name}-github-deployer"
  assume_role_policy   = data.aws_iam_policy_document.deployer_assume.json
  max_session_duration = 3600
}

# Push to the two app repositories, and find the cluster. What it may do inside the cluster is
# set by its EKS access entry (eks.tf), not by IAM.
data "aws_iam_policy_document" "deployer" {
  statement {
    sid       = "EcrLogin"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    sid = "EcrPush"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:CompleteLayerUpload",
      "ecr:InitiateLayerUpload",
      "ecr:PutImage",
      "ecr:UploadLayerPart",
    ]
    resources = [for repo in aws_ecr_repository.app : repo.arn]
  }
  statement {
    sid       = "EksDescribe"
    actions   = ["eks:DescribeCluster"]
    resources = [aws_eks_cluster.main.arn]
  }
}

resource "aws_iam_role_policy" "deployer" {
  name   = "deploy"
  role   = aws_iam_role.deployer.id
  policy = data.aws_iam_policy_document.deployer.json
}

# --- Pod roles (EKS Pod Identity) ----------------------------------------------------------------

# The trust policy for every Pod Identity role: the EKS Pod Identity agent assumes it for a Pod.
data "aws_iam_policy_document" "pod_identity_assume" {
  statement {
    actions = ["sts:AssumeRole", "sts:TagSession"]
    principals {
      type        = "Service"
      identifiers = ["pods.eks.amazonaws.com"]
    }
  }
}

# External Secrets Operator: read the three app secrets, nothing else.
resource "aws_iam_role" "external_secrets" {
  name               = "${local.name}-external-secrets"
  assume_role_policy = data.aws_iam_policy_document.pod_identity_assume.json
}

data "aws_iam_policy_document" "external_secrets" {
  statement {
    actions   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
    resources = [for secret in aws_secretsmanager_secret.app : secret.arn]
  }
}

resource "aws_iam_role_policy" "external_secrets" {
  name   = "read-app-secrets"
  role   = aws_iam_role.external_secrets.id
  policy = data.aws_iam_policy_document.external_secrets.json
}

# AWS Load Balancer Controller: creates the NLB in front of the Envoy proxy. The policy is the
# controller's official one, copied from its v3.6.3 release (docs/install/iam_policy.json).
resource "aws_iam_role" "load_balancer_controller" {
  name               = "${local.name}-load-balancer-controller"
  assume_role_policy = data.aws_iam_policy_document.pod_identity_assume.json
}

resource "aws_iam_policy" "load_balancer_controller" {
  name   = "${local.name}-load-balancer-controller"
  policy = file("${path.module}/policies/aws-load-balancer-controller.json")
}

resource "aws_iam_role_policy_attachment" "load_balancer_controller" {
  role       = aws_iam_role.load_balancer_controller.name
  policy_arn = aws_iam_policy.load_balancer_controller.arn
}
