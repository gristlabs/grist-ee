#!/bin/bash

# This is a script for updating the material in the ext directory.
# It is a bit delicate, and for use in automation.

set -e

monorepo="$1"
if [[ "$monorepo" = "" ]]; then
  echo "Please supply path to grist monorepo"
  exit 1
fi

if [ ! -e "$monorepo/ext" ]; then
  echo "Cannot find ext directory"
  exit 1
fi

workdir=tmp_checkout

# Make a clean copy of ext directory by brute force.
rm -rf $workdir
git clone $monorepo $workdir
# There used to be complicated logic here to match commits between
# core and ext, but it isn't practical. Better to just run this script
# in the correct order in a sync.
rm -rf ext
cp -r $workdir/ext ext
git add --all ext
rm -rf $workdir
