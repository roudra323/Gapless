# The S3 bucket that holds the Terraform state of envs/dev (docs/07 "Layout"). Run once per
# account. The account ID in the name makes it unique, because bucket names are global.
data "aws_caller_identity" "current" {}

resource "aws_s3_bucket" "state" {
  bucket = "gapless-tfstate-${data.aws_caller_identity.current.account_id}"

  # Losing this bucket loses the record of every resource. Terraform refuses to destroy it.
  lifecycle {
    prevent_destroy = true
  }
}

# Every state write keeps the old version, so a broken state can be restored.
resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id

  versioning_configuration {
    status = "Enabled"
  }
}

# State can hold sensitive values. Encrypt it at rest.
resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# No public access, whatever a later ACL or bucket policy says.
resource "aws_s3_bucket_public_access_block" "state" {
  bucket = aws_s3_bucket.state.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
