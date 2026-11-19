{{/* core 的 image、共用的環境變數 */}}
{{- define "core.image" -}}{{ .Values.global.image.repository }}/core-api:{{ .Values.global.image.tag }}{{- end -}}
{{- define "core.env" -}}
envFrom:
  - configMapRef: { name: core-env }
env:
  - name: APP_KEY
    valueFrom: { secretKeyRef: { name: core-secrets, key: APP_KEY } }
{{- end -}}
{{/* 每個 core Pod 啟動前先跑 migration：--isolated 用 Redis 鎖，同時好幾個 Pod 啟動也只有一個真的執行 */}}
{{- define "core.migrate" -}}
initContainers:
  - name: migrate
    image: {{ include "core.image" . }}
    imagePullPolicy: {{ .Values.global.image.pullPolicy }}
    command: ["sh", "-c", "until php artisan migrate --force --isolated; do echo '等資料庫…'; sleep 3; done"]
    envFrom:
      - configMapRef: { name: core-env }
    env:
      - name: APP_KEY
        valueFrom: { secretKeyRef: { name: core-secrets, key: APP_KEY } }
{{- end -}}
