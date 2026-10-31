# FD-3: the network of the synthetic profile (profile.tf). Exists only when deployment_profile = "synthetic" and no vpc_id is supplied.
#
# Public subnets only, no NAT gateway (a NAT costs money every hour and is the one piece the free plan is least likely to cover): the API tasks
# get a public address so they can reach AWS services and Cognito's key endpoint, and the S3 gateway endpoint keeps report-file and image-layer
# traffic off the internet. The security groups are NOT relaxed (api-edge.tf): the tasks accept port 3000 from the load balancer only and send
# out only to the database and over HTTPS. The database sits in the same subnets with no public address and a group that admits only the tasks.
# `terraform destroy` removes all of it, which is the point of creating it here instead of borrowing the account's default VPC.

locals {
  synthetic_vpc_cidr = "10.42.0.0/16"
}

# RDS needs subnets in at least two zones even when it is not Multi-AZ, so the two subnets are pinned to the first two zones.
data "aws_availability_zones" "available" {
  count = local.network_count
  state = "available"
  filter {
    name   = "opt-in-status"
    values = ["opt-in-not-required"]
  }
}

resource "aws_vpc" "synthetic" {
  count                = local.network_count
  cidr_block           = local.synthetic_vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = "${local.name}-synthetic" }
}

# The VPC's default security group admits nothing and sends nothing; every group that matters is declared by name elsewhere.
resource "aws_default_security_group" "synthetic" {
  count  = local.network_count
  vpc_id = aws_vpc.synthetic[0].id
  tags   = { Name = "${local.name}-synthetic-default-closed" }
}

resource "aws_internet_gateway" "synthetic" {
  count  = local.network_count
  vpc_id = aws_vpc.synthetic[0].id
  tags   = { Name = "${local.name}-synthetic" }
}

resource "aws_subnet" "synthetic" {
  count                   = local.network_count * 2
  vpc_id                  = aws_vpc.synthetic[0].id
  availability_zone       = data.aws_availability_zones.available[0].names[count.index]
  cidr_block              = cidrsubnet(local.synthetic_vpc_cidr, 8, count.index)
  map_public_ip_on_launch = false
  tags                    = { Name = "${local.name}-synthetic-public-${count.index}" }
}

resource "aws_route_table" "synthetic" {
  count  = local.network_count
  vpc_id = aws_vpc.synthetic[0].id
  tags   = { Name = "${local.name}-synthetic-public" }
}

resource "aws_route" "synthetic_internet" {
  count                  = local.network_count
  route_table_id         = aws_route_table.synthetic[0].id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.synthetic[0].id
}

resource "aws_route_table_association" "synthetic" {
  count          = local.network_count * 2
  subnet_id      = aws_subnet.synthetic[count.index].id
  route_table_id = aws_route_table.synthetic[0].id
}

# Free, and it keeps S3 traffic inside AWS.
resource "aws_vpc_endpoint" "synthetic_s3" {
  count             = local.network_count
  vpc_id            = aws_vpc.synthetic[0].id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.synthetic[0].id]
  tags              = { Name = "${local.name}-synthetic-s3" }
}
