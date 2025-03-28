# To run Grist:
#   Check out gristlabs/grist-core into the core subdirectory. Then,
#   make requirements
#   make build
#   GRIST_SESSION_SECRET=something make start
#
# To build gristlabs/grist-ee image:
#   make docker
#
# See core/Dockerfile for version hints. Node 10 or greater should
# work, with python 3.9 or greater (or python 2.7 if you are old-school).
# Will need yarn installed, and a recent version of docker to build a
# docker image.

default:
	@echo "To make and run Grist:"
	@echo "  make requirements"
	@echo "  make build"
	@echo "  GRIST_SESSION_SECRET=something make start"
	@echo ""
	@echo "To make a Grist image (does not require above steps):"
	@echo "  make docker"

requirements:
	cd ext && yarn install --frozen-lockfile --modules-folder=../node_modules --verbose
	cd core && yarn install --frozen-lockfile --verbose
	cd core && test -e ext && echo ext present || ln -s ../ext ext
	cd core && yarn run install:python

build:
	cd core && yarn run build

start:
	cd core && yarn start

docker:
	docker buildx build --load -t gristlabs/grist-ee --build-context=ext=ext core
