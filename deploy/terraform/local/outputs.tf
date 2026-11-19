output "urls" {
  value = {
    storefront = "http://localhost:${var.ingress_port}"
    admin      = "http://core.localhost:${var.ingress_port}/admin"
    partners   = "http://partners.localhost:${var.ingress_port}"
    grafana    = "http://grafana.localhost:${var.ingress_port}"
    headlamp   = "http://headlamp.localhost:${var.ingress_port}"
    localstack = "http://localstack.localhost:${var.ingress_port}"
  }
}

output "kube_context" { value = module.cluster.context }

output "queues" { value = keys(module.queues.queue_urls) }
