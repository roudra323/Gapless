variable "region" {
  description = "AWS region for the state bucket (docs/07)."
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
