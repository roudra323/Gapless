# On AWS every emulator setting below is null or false, so the provider uses its normal
# credential chain and endpoints. On Floci (var.emulator) it uses dummy credentials, does not look
# for an EC2 instance role, and sends every call to Floci (adr/0004 rule 1). Floci answers STS
# like AWS, so the credential and account-ID checks stay on.
provider "aws" {
  region = var.region

  access_key              = var.emulator ? "test" : null
  secret_key              = var.emulator ? "test" : null
  skip_metadata_api_check = var.emulator
  s3_use_path_style       = var.emulator

  # Every AWS service this root calls. Add a service here when a new file uses it.
  endpoints {
    budgets        = var.emulator ? var.emulator_endpoint : null
    ec2            = var.emulator ? var.emulator_endpoint : null
    ecr            = var.emulator ? var.emulator_endpoint : null
    eks            = var.emulator ? var.emulator_endpoint : null
    iam            = var.emulator ? var.emulator_endpoint : null
    rds            = var.emulator ? var.emulator_endpoint : null
    s3             = var.emulator ? var.emulator_endpoint : null
    s3control      = var.emulator ? var.emulator_endpoint : null
    secretsmanager = var.emulator ? var.emulator_endpoint : null
    sts            = var.emulator ? var.emulator_endpoint : null
  }

  default_tags {
    tags = {
      Project     = "gapless"
      Environment = "dev"
      ManagedBy   = "terraform"
    }
  }
}
