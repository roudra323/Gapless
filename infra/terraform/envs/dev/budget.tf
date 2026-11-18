# The cost alarm (docs/07: "Create it first"). It is the first resource of this root, so it exists
# before anything that costs money. Alerts at 50%, 90% and 100% of the actual monthly cost.
resource "aws_budgets_budget" "monthly" {
  name         = "gapless-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.budget_limit_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  dynamic "notification" {
    for_each = [50, 90, 100]

    content {
      comparison_operator        = "GREATER_THAN"
      threshold                  = notification.value
      threshold_type             = "PERCENTAGE"
      notification_type          = "ACTUAL"
      subscriber_email_addresses = [var.budget_alert_email]
    }
  }
}
