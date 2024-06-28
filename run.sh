#!/usr/bin/with-contenv bashio

export INGRESS_PATH="$(bashio::addon.ingress_entry)"
export PORT=6789
node server.js