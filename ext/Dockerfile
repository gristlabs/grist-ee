################################################################################
## The enterprise image extends the existing combined image, enabling enterprise
## features by default.
################################################################################

ARG BASE_IMAGE=gristlabs/grist
ARG BASE_VERSION=latest
FROM ${BASE_IMAGE}:${BASE_VERSION}

## Enable EE features.
ENV GRIST_FORCE_ENABLE_ENTERPRISE=true
