# One mocked plan exports actual generated policies for policy.test.mjs.
# No captured policy JSON, real provider, credentials or apply belongs in this fixture.
mock_provider "aws" {
  override_during = plan
  mock_resource "aws_kms_key" {
    defaults = { arn = "arn:aws:kms:us-east-1:123456789012:key/11111111-1111-1111-1111-111111111111" }
  }
}

variables {
  region                    = "us-east-1"
  bucket_name               = "telesphoros-synthetic-state-test"
  state_key                 = "staging/terraform.tfstate"
  state_principal_arn       = "arn:aws:iam::123456789012:role/terraform-state-owner"
  noncurrent_retention_days = 90
}

run "policy_probe_fixture" {
  command = plan
}
