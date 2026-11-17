{{/* The chart name, or nameOverride. */}}
{{- define "gapless.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* The prefix for every object name: the release name, plus the chart name if not in it. */}}
{{- define "gapless.fullname" -}}
{{- $name := include "gapless.name" . -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{/* The image tag: required, and never `latest` (docs/07 "Pod standards"). */}}
{{- define "gapless.imageTag" -}}
{{- $tag := required "image.tag is required (the git SHA)" .Values.image.tag -}}
{{- if eq $tag "latest" -}}
{{- fail "image.tag must be a git SHA, not latest" -}}
{{- end -}}
{{- $tag -}}
{{- end -}}

{{/*
Labels that never change for a workload. Selectors use only these, because a Deployment's
selector cannot change after it is created.
Call with: (dict "root" $ "component" "api")
*/}}
{{- define "gapless.selectorLabels" -}}
app.kubernetes.io/name: {{ include "gapless.name" .root }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{/* The standard labels (docs/07 "Pod standards"). Call with: (dict "root" $ "component" "api") */}}
{{- define "gapless.labels" -}}
{{ include "gapless.selectorLabels" . }}
app.kubernetes.io/version: {{ include "gapless.imageTag" .root | quote }}
app.kubernetes.io/part-of: gapless
app.kubernetes.io/managed-by: {{ .root.Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .root.Chart.Name .root.Chart.Version }}
{{- end -}}

{{/* A NetworkPolicy peer: the Prometheus Pods of kube-prometheus-stack (step 6). */}}
{{- define "gapless.prometheusPeer" -}}
# Both selectors in one entry: the Pod must match both (AND, not OR).
- namespaceSelector:
    matchLabels:
      kubernetes.io/metadata.name: {{ .Values.networkPolicy.prometheusNamespace }}
  podSelector:
    matchLabels:
      app.kubernetes.io/name: prometheus
{{- end -}}
