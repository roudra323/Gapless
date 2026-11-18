variable "region" {
  description = "AWS region for every resource (docs/07)."
  type        = string
  default     = "ap-south-1"
}

variable "emulator" {
  description = "true = run against the local Floci emulator (adr/0004). Only the provider settings change."
  type        = bool
  default     = false
}

variable "emulator_endpoint" {
  description = "Floci's URL, used only when emulator = true."
  type        = string
  default     = "http://localhost:4566"
}

variable "budget_limit_usd" {
  description = "Monthly cost budget in USD. Alerts go out at 50%, 90% and 100% of it."
  type        = number
  default     = 20
}

variable "budget_alert_email" {
  description = "Email address for the budget alerts. Set it in terraform.tfvars (git-ignored)."
  type        = string
}

variable "vpc_cidr" {
  description = "CIDR block of the VPC. The subnets are cut from it (network.tf)."
  type        = string
  default     = "10.0.0.0/16"
}

variable "kubernetes_version" {
  description = "EKS Kubernetes minor version, in standard support (docs/04; the kind cluster uses the same minor)."
  type        = string
  default     = "1.37"
}

variable "node_instance_types" {
  description = "Spot instance types for the node group. Two types give Spot more capacity pools (docs/07)."
  type        = list(string)
  default     = ["t3.medium", "t3a.medium"]
}

variable "node_scaling" {
  description = "Size of the Spot node group."
  type = object({
    min     = number
    desired = number
    max     = number
  })
  default = { min = 1, desired = 2, max = 3 }
}

variable "github_repository" {
  description = "The GitHub repository (owner/name) whose main branch may assume the deployer role."
  type        = string
  default     = "roudra323/Gapless"
}

variable "db_instance_class" {
  description = "RDS instance class: the smallest burstable one (docs/07)."
  type        = string
  default     = "db.t4g.micro"
}
