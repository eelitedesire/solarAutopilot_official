ARG BUILD_FROM
FROM $BUILD_FROM

# Install Node.js, npm, and Grafana
RUN apk add --no-cache nodejs npm grafana

# Create a grafana user and group
RUN addgroup -S grafana || true && \
    adduser -S -G grafana grafana || true

# Set working directory
WORKDIR /app

# Copy package.json and install dependencies
COPY package.json .
RUN npm install

# Copy the rest of the application
COPY . .

# Copy Grafana configuration
COPY grafana/grafana.ini /etc/grafana/grafana.ini
COPY grafana/provisioning /etc/grafana/provisioning
COPY grafana/dashboards /var/lib/grafana/dashboards

# Set correct permissions
RUN chown -R grafana:grafana /var/lib/grafana /etc/grafana

# Make run script executable
RUN chmod a+x run.sh

# Expose ports for Node.js and Grafana
EXPOSE 6789 3000

CMD [ "/app/run.sh" ]