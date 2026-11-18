# Values that `make eks-bootstrap`, the deploy workflow and the Secrets Manager setup need
# (docs/07, Phase 9b).

output "cluster_name" {
  description = "EKS cluster name, for `aws eks update-kubeconfig`."
  value       = aws_eks_cluster.main.name
}

output "cluster_endpoint" {
  description = "Kubernetes API server URL."
  value       = aws_eks_cluster.main.endpoint
}

output "vpc_id" {
  description = "VPC ID, for the AWS Load Balancer Controller's Helm values."
  value       = aws_vpc.main.id
}

output "ecr_repositories" {
  description = "Image repository URL per app, for the deploy workflow."
  value       = { for app, repo in aws_ecr_repository.app : app => repo.repository_url }
}

output "deployer_role_arn" {
  description = "IAM role that GitHub Actions assumes with OIDC (role-to-assume)."
  value       = aws_iam_role.deployer.arn
}

output "db_endpoint" {
  description = "RDS host:port, for the DATABASE_URL secret."
  value       = aws_db_instance.main.endpoint
}

output "db_master_secret_arn" {
  description = "Secrets Manager secret (created by RDS) that holds the database password."
  value       = aws_db_instance.main.master_user_secret[0].secret_arn
}

output "app_secret_arns" {
  description = "The app secrets that External Secrets reads; set their values outside Terraform."
  value       = { for name, secret in aws_secretsmanager_secret.app : name => secret.arn }
}
