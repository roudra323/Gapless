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
