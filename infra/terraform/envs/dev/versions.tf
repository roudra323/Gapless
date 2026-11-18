# The Terraform and provider versions this root needs (docs/04). The exact provider version is
# locked in .terraform.lock.hcl, which is committed.
terraform {
  required_version = ">= 1.17.0, < 2.0.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  # State in the bootstrap bucket, locked with a lock file next to it (S3-native locking; the
  # DynamoDB lock table is deprecated, docs/04). The bucket, region and endpoint come from a
  # `-backend-config` file: floci.s3.tfbackend for Floci, never the real bucket (adr/0004 rule 2).
  backend "s3" {
    key          = "envs/dev/terraform.tfstate"
    use_lockfile = true
    encrypt      = true
  }
}
