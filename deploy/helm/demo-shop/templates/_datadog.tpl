{{/*
Datadog（預設關閉）：global.datadog.enabled 時，trace 和指標送到「這個 Pod 所在 Node」上的 Agent
（Agent 是 DaemonSet，每個 Node 一個，APM 用 hostPort 8126、DogStatsD 用 8125；由 Terraform 安裝，deploy/terraform/modules/datadog）
用法：{{ include "demo.datadog.env" (dict "root" $ "service" "core-api" "kind" "php-fpm") }}
  kind：php-fpm（每個請求自己一個 root span）、php-cli（常駐程序）、node（dd-trace 用 --import 載入）
沒開時明確關掉 trace：PHP 的 ddtrace 預設是開的，會一直嘗試連 localhost:8126
Agent 收 log 時直接讀容器的 DD_SERVICE／DD_ENV／DD_VERSION 標記是哪個服務（unified service tagging），不用另外加 Pod 標籤
*/}}
{{- define "demo.datadog.env" -}}
{{- $root := .root -}}
{{- if $root.Values.global.datadog.enabled }}
- name: DD_AGENT_HOST
  valueFrom: { fieldRef: { fieldPath: status.hostIP } }
- { name: DD_TRACE_ENABLED, value: {{ if eq (toString $root.Values.global.datadog.apm) "false" }}"false"{{ else }}"true"{{ end }} }
- { name: DD_SERVICE, value: {{ .service | quote }} }
- { name: DD_ENV, value: {{ $root.Values.global.datadog.env | quote }} }
- { name: DD_VERSION, value: {{ $root.Values.global.image.tag | quote }} }
- { name: DD_LOGS_INJECTION, value: "true" }
{{- if eq .kind "node" }}
- { name: NODE_OPTIONS, value: "--import dd-trace/initialize.mjs" }
{{- else if eq .kind "php-cli" }}
- { name: DD_TRACE_CLI_ENABLED, value: "true" }
- { name: DD_TRACE_GENERATE_ROOT_SPAN, value: "false" }
{{- else if eq .kind "php-fpm" }}
- { name: DD_TRACE_GENERATE_ROOT_SPAN, value: "true" }
{{- end }}
{{- else }}
- { name: DD_TRACE_ENABLED, value: "false" }
{{- end }}
{{- end -}}

