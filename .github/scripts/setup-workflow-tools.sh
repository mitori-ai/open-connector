#!/usr/bin/env bash

set -euo pipefail

KUSTOMIZE_VERSION="${KUSTOMIZE_VERSION:-v5.7.1}"
YQ_VERSION="${YQ_VERSION:-v4.45.4}"

curl -sSfL "https://github.com/kubernetes-sigs/kustomize/releases/download/kustomize/${KUSTOMIZE_VERSION}/kustomize_${KUSTOMIZE_VERSION}_linux_amd64.tar.gz" \
  | sudo tar -xz -C /usr/local/bin kustomize

sudo curl -sSfL -o /usr/local/bin/yq "https://github.com/mikefarah/yq/releases/download/${YQ_VERSION}/yq_linux_amd64"
sudo chmod +x /usr/local/bin/yq

kustomize version
yq --version
