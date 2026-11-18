{{- define "scribyra-operator.labels" -}}
app.kubernetes.io/name: scribyra-operator
app.kubernetes.io/part-of: scribyra
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}
{{- define "scribyra-operator.image" -}}
{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}
{{- end -}}
