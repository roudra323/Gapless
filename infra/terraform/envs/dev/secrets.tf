# The app's secrets (docs/07). Terraform creates only the empty secrets; the values are set with
# `aws secretsmanager put-secret-value`, so they never enter the Terraform state. External Secrets
# Operator copies them into the cluster (iam.tf gives it read access to these three only).
locals {
  secrets = toset(["database-url", "rpc-http-url", "rpc-ws-url"])
}

resource "aws_secretsmanager_secret" "app" {
  for_each = local.secrets

  name        = "gapless/${each.key}"
  description = "Gapless ${each.key} (value set outside Terraform)"
  # Delete at once on destroy, so the next apply can create the same name again.
  recovery_window_in_days = 0
}
