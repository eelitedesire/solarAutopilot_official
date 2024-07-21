#!/usr/bin/with-contenv bashio
export INGRESS_PATH="$(bashio::addon.ingress_entry)"
export PORT=6789
export MQTT_IP=$(bashio::config 'mqtt_ip')
# Start Grafana
/usr/sbin/grafana-server --homepath=/usr/share/grafana --config=/etc/grafana/grafana.ini web --addr=0.0.0.0 &

# Wait for Grafana to start
echo "Waiting for Grafana to start..."
while ! nc -z localhost 3000; do
    sleep 1
done
echo "Grafana has started"

# Start your Node.js server
node server.js