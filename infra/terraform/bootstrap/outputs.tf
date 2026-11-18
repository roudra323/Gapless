output "state_bucket" {
  description = "The state bucket name, for the backend configuration of envs/dev."
  value       = aws_s3_bucket.state.bucket
}
