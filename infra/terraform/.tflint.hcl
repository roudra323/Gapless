# tflint for every root under infra/terraform (`make tf-check`, CI job `terraform`).
# The image and this plugin are pinned (docs/04).
config {
  call_module_type = "none"
}

plugin "terraform" {
  enabled = true
  preset  = "recommended"
}

plugin "aws" {
  enabled = true
  version = "0.50.0"
  source  = "github.com/terraform-linters/tflint-ruleset-aws"
}
