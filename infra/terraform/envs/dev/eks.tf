# The EKS cluster (docs/07, adr/0003): standard mode, access entries for cluster access (not the
# aws-auth ConfigMap), a Spot managed node group in the public subnets, and the add-ons the
# platform needs. The cluster add-ons that come from Helm are installed by `make eks-bootstrap`.

resource "aws_eks_cluster" "main" {
  name     = local.name
  version  = var.kubernetes_version
  role_arn = aws_iam_role.cluster.arn

  access_config {
    authentication_mode = "API"
    # The identity that runs `terraform apply` becomes cluster admin, so it can bootstrap the
    # add-ons. Everyone else gets an access entry below.
    bootstrap_cluster_creator_admin_permissions = true
  }

  vpc_config {
    subnet_ids              = aws_subnet.public[*].id
    endpoint_public_access  = true
    endpoint_private_access = true
  }

  # Never move into paid extended support: a version past standard support must be upgraded.
  # Floci does not return this setting, so on Floci it is left out (docs/07 "Floci coverage").
  dynamic "upgrade_policy" {
    for_each = var.emulator ? [] : [1]

    content {
      support_type = "STANDARD"
    }
  }

  depends_on = [aws_iam_role_policy_attachment.cluster]
}

resource "aws_eks_node_group" "spot" {
  cluster_name    = aws_eks_cluster.main.name
  node_group_name = "${local.name}-spot"
  node_role_arn   = aws_iam_role.node.arn
  subnet_ids      = aws_subnet.public[*].id

  capacity_type  = "SPOT"
  instance_types = var.node_instance_types
  ami_type       = "AL2023_x86_64_STANDARD"
  disk_size      = 20

  scaling_config {
    min_size     = var.node_scaling.min
    desired_size = var.node_scaling.desired
    max_size     = var.node_scaling.max
  }

  update_config {
    max_unavailable = 1
  }

  # The node role must have its policies before a node tries to join, and keep them until the
  # last node is gone on destroy.
  depends_on = [aws_iam_role_policy_attachment.node]
}

# --- Add-ons -------------------------------------------------------------------------------------

resource "aws_eks_addon" "vpc_cni" {
  cluster_name = aws_eks_cluster.main.name
  addon_name   = "vpc-cni"
  # The VPC CNI enforces NetworkPolicy, so the chart's policies work on EKS as they do on kind.
  configuration_values = jsonencode({ enableNetworkPolicy = "true" })
}

resource "aws_eks_addon" "kube_proxy" {
  cluster_name = aws_eks_cluster.main.name
  addon_name   = "kube-proxy"
}

resource "aws_eks_addon" "coredns" {
  cluster_name = aws_eks_cluster.main.name
  addon_name   = "coredns"
  # CoreDNS runs as Pods, so it needs nodes first.
  depends_on = [aws_eks_node_group.spot]
}

resource "aws_eks_addon" "pod_identity_agent" {
  cluster_name = aws_eks_cluster.main.name
  addon_name   = "eks-pod-identity-agent"
}

# --- Pod Identity: which Kubernetes service account gets which IAM role ------------------------

resource "aws_eks_pod_identity_association" "external_secrets" {
  cluster_name    = aws_eks_cluster.main.name
  namespace       = "external-secrets"
  service_account = "external-secrets"
  role_arn        = aws_iam_role.external_secrets.arn
}

resource "aws_eks_pod_identity_association" "load_balancer_controller" {
  cluster_name    = aws_eks_cluster.main.name
  namespace       = "kube-system"
  service_account = "aws-load-balancer-controller"
  role_arn        = aws_iam_role.load_balancer_controller.arn
}

# --- Access entries: who may use the Kubernetes API ----------------------------------------------

# The CI deployer may change resources in the gapless namespace only (docs/07).
resource "aws_eks_access_entry" "deployer" {
  cluster_name  = aws_eks_cluster.main.name
  principal_arn = aws_iam_role.deployer.arn
}

resource "aws_eks_access_policy_association" "deployer" {
  cluster_name  = aws_eks_cluster.main.name
  principal_arn = aws_iam_role.deployer.arn
  policy_arn    = "arn:${data.aws_partition.current.partition}:eks::aws:cluster-access-policy/AmazonEKSEditPolicy"

  access_scope {
    type       = "namespace"
    namespaces = ["gapless"]
  }

  depends_on = [aws_eks_access_entry.deployer]
}
