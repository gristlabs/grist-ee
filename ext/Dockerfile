################################################################################
## The enterprise image extends the existing combined image, enabling enterprise
## features by default.
################################################################################

ARG BASE_VERSION=latest
FROM gristlabs/grist:${BASE_VERSION}

## Enable EE features.
ENV TEST_ENABLE_ACTIVATION=true
