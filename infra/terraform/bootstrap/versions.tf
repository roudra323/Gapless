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

  # Local state: this root creates the bucket that holds every other state, so its own state
  # cannot live there. A Floci run passes another path (`-backend-config=path=floci.tfstate`), so
  # it never touches the real state file (adr/0004 rule 2).
  backend "local" {}
}
