const express = require('express');
const bodyParser = require('body-parser');
const mqtt = require('mqtt');
const fs = require('fs');
const path = require('path');
const Influx = require('influx');
const ejs = require('ejs');
const moment = require('moment');
const WebSocket = require('ws');

const app = express();
const port = process.env.PORT || 6789;

// Middleware setup
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static('public'));
app.set('view engine', 'ejs');

// Read configuration from Home Assistant add-on options
const options = JSON.parse(fs.readFileSync('/data/options.json', 'utf8'));

// InfluxDB configuration
const influxConfig = {
    host: options.mqtt_ip,
    port: 8086,
    database: 'homeassistant',
    username: 'admin',
    password: 'adminadmin',
};
const influx = new Influx.InfluxDB(influxConfig);

// MQTT configuration
const mqttConfig = {
    host: options.mqtt_ip,
    port: options.mqtt_port,
    username: options.mqtt_username,
    password: options.mqtt_password,
};

// Connect to MQTT broker
let mqttClient;
let incomingMessages = [];
const MAX_MESSAGES = 100;

function connectToMqtt() {
    mqttClient = mqtt.connect(`mqtt://${mqttConfig.host}:${mqttConfig.port}`, {
        username: mqttConfig.username,
        password: mqttConfig.password,
    });

    mqttClient.on('connect', () => {
        console.log('Connected to MQTT broker');
        mqttClient.subscribe('solar_assistant_DEYE/#');
    });

    mqttClient.on('message', (topic, message) => {
        const formattedMessage = `${topic}: ${message.toString()}`;
        incomingMessages.push(formattedMessage);
        if (incomingMessages.length > MAX_MESSAGES) {
            incomingMessages.shift();
        }
        saveMessageToInfluxDB(topic, message);
        updateSystemState(topic, message);
    });

    mqttClient.on('error', (err) => {
        console.error('Error connecting to MQTT broker:', err.message);
        mqttClient = null;
    });
}

// Data storage
let automationRules = [];
let scheduledSettings = [];
let universalSettings = {
    maxBatteryDischargePower: 500,
    gridChargeOn: false,
    generatorChargeOn: false,
    dischargeVoltage: 48.0
};

// Inverter configuration
let inverterConfig = {
    Deye: {
        workMode: ['Selling first', 'Zero Export to Load', 'Selling first'],
        solarExportWhenBatteryFull: true,
        energyPattern: ['Load First', 'Battery First'],
        maxSellPower: 5000
    },
    MPP: {
        // Add MPP-specific settings here
    }
};

let currentInverterType = 'Deye';
let currentInverterSettings = { ...inverterConfig.Deye };

// Current system state
let currentSystemState = {
    inverter_1: {},
    inverter_2: {},
    battery_1: {},
    total: {},
    batteryPower: 0,
    batterySOC: 0,
    solarPower: 0,
    gridPower: 0,
    loadPower: 0,
    time: new Date(),
};

// Function to update the current system state
function updateSystemState(topic, message) {
    const topicParts = topic.split('/');
    const deviceType = topicParts[1];
    const measurement = topicParts.slice(2, -1).join('_');

    let value;
    try {
        value = parseFloat(message.toString());
        if (isNaN(value)) {
            value = message.toString();
        }
    } catch (error) {
        console.error(`Error parsing message payload: ${error.message}`);
        return;
    }

    if (!currentSystemState[deviceType]) {
        currentSystemState[deviceType] = {};
    }
    currentSystemState[deviceType][measurement] = value;
    currentSystemState.time = new Date();

    // Special handling for 'total' measurements
    if (deviceType === 'total') {
        switch(measurement) {
            case 'battery_power':
                currentSystemState.batteryPower = value;
                break;
            case 'battery_state_of_charge':
                currentSystemState.batterySOC = value;
                break;
            case 'grid_power':
                currentSystemState.gridPower = value;
                break;
            case 'load_power':
                currentSystemState.loadPower = value;
                break;
            case 'pv_power':
                currentSystemState.solarPower = value;
                break;
        }
    }

    broadcastMessage({ type: 'stateUpdate', state: currentSystemState });
}

// Save MQTT message to InfluxDB
function saveMessageToInfluxDB(topic, message) {
    try {
        const parsedMessage = parseFloat(message.toString());

        if (isNaN(parsedMessage)) {
            return;
        }

        const timestamp = new Date().getTime();
        const dataPoint = {
            measurement: 'state',
            fields: { value: parsedMessage },
            tags: { topic: topic },
            timestamp: timestamp * 1000000,
        };

        influx.writePoints([dataPoint])
            .then(() => {
                // console.log('Message saved to InfluxDB');
            })
            .catch((err) => {
                console.error('Error saving message to InfluxDB:', err.toString());
            });
    } catch (error) {
        console.error('Error parsing message:', error.message);
    }
}

// Fetch current value from InfluxDB
async function getCurrentValue(topic) {
    const query = `
        SELECT mean("value") AS "value"
        FROM "state"
        WHERE "topic" = '${topic}'
        AND time >= now() - 2d
        GROUP BY time(1d) tz('Indian/Mauritius')
    `;
    try {
        return await influx.query(query);
    } catch (error) {
        console.error(`Error querying InfluxDB for topic ${topic}:`, error.toString());
        throw error;
    }
}

async function getCurrentData(topic) {
    const query = `
        SELECT last("value") AS "value"
        FROM "state"
        WHERE "topic" = '${topic}'
        ORDER BY time DESC
        LIMIT 1
    `;

    try {
        const result = await influx.query(query);
        return result[0];
    } catch (error) {
        console.error(`Error querying InfluxDB for topic ${topic}:`, error);
        throw error;
    }
}

// Fetch analytics data from InfluxDB
async function queryInfluxDB(topic) {
    const query = `
        SELECT mean("value") AS "value"
        FROM "state"
        WHERE "topic" = '${topic}'
        AND time >= now() - 30d
        GROUP BY time(1d) tz('Indian/Mauritius')
    `;
    try {
        return await influx.query(query);
    } catch (error) {
        console.error(`Error querying InfluxDB for topic ${topic}:`, error.toString());
        throw error;
    }
}

// Calculate daily difference
function calculateDailyDifference(data) {
    return data.map((current, index, array) => {
        if (index === 0 || !array[index - 1].value) {
            return { ...current, value: 0 };
        } else {
            const previousData = array[index - 1].value;
            const currentData = current.value;
            return currentData >= previousData
                ? { ...current, value: currentData - previousData }
                : { ...current };
        }
    });
}

// Route handlers

app.get('/settings', (req, res) => {
    res.render('settings', { ingress_path: process.env.INGRESS_PATH || '' });
});

app.get('/messages', (req, res) => {
    res.render('messages', { ingress_path: process.env.INGRESS_PATH || '' });
});

app.get('/api/messages', (req, res) => {
    const categoryFilter = req.query.category;
    const filteredMessages = filterMessagesByCategory(categoryFilter);
    res.json(filteredMessages);
});

app.get('/dashboard', async (req, res) => {
    try {
        const loadPowerData = await getCurrentValue('solar_assistant_DEYE/total/load_energy/state');
        const pvPowerData = await getCurrentValue('solar_assistant_DEYE/total/pv_energy/state');
        const batteryPowerInData = await getCurrentValue('solar_assistant_DEYE/total/battery_energy_in/state');
        const batteryPowerOutData = await getCurrentValue('solar_assistant_DEYE/total/battery_energy_out/state');
        const gridPowerInData = await getCurrentValue('solar_assistant_DEYE/total/grid_energy_in/state');
        const gridPowerOutData = await getCurrentValue('solar_assistant_DEYE/total/grid_energy_out/state');

        const loadPowerDataDaily = calculateDailyDifference(loadPowerData);
        const pvPowerDataDaily = calculateDailyDifference(pvPowerData);
        const batteryPowerInDataDaily = calculateDailyDifference(batteryPowerInData);
        const batteryPowerOutDataDaily = calculateDailyDifference(batteryPowerOutData);
        const gridPowerInDataDaily = calculateDailyDifference(gridPowerInData);
        const gridPowerOutDataDaily = calculateDailyDifference(gridPowerOutData);

        const hourlyData = loadPowerDataDaily.map((load, index) => ({
            hour: moment(load.time).format('HH'),
            load: load.value || 0,
            solar: (pvPowerDataDaily[index] && pvPowerDataDaily[index].value) || 0,
            battery: (batteryPowerOutDataDaily[index] && batteryPowerOutDataDaily[index].value) || 0,
            grid: (gridPowerInDataDaily[index] && gridPowerInDataDaily[index].value) || 0
        }));

        const data = {
            totalConsumption: loadPowerDataDaily.reduce((acc, load) => acc + (load.value || 0), 0),
            solarProduction: pvPowerDataDaily.reduce((acc, pv) => acc + (pv.value || 0), 0),
            gridIn: gridPowerInDataDaily.reduce((acc, grid) => acc + Math.max(grid.value || 0, 0), 0),
            gridOut: gridPowerOutDataDaily.reduce((acc, grid) => acc + Math.min(grid.value || 0, 0), 0),
            batteryCharged: batteryPowerInDataDaily.reduce((acc, battery) => acc + Math.max(battery.value || 0, 0), 0),
            batteryDischarged: batteryPowerOutDataDaily.reduce((acc, battery) => acc + Math.min(battery.value || 0, 0), 0),
            hourlyData
        };

        res.render('dashboard', { data, ingress_path: process.env.INGRESS_PATH || '' });
    } catch (error) {
        console.error('Error fetching data for dashboard:', error);
        res.status(500).json({ error: 'Error fetching data for dashboard' });
    }
});

app.get('/api/energy', async (req, res) => {
    try {
        const loadPowerData = await getCurrentValue('solar_assistant_DEYE/total/load_energy/state');
        const pvPowerData = await getCurrentValue('solar_assistant_DEYE/total/pv_energy/state');
        const batteryPowerInData = await getCurrentValue('solar_assistant_DEYE/total/battery_energy_in/state');
        const batteryPowerOutData = await getCurrentValue('solar_assistant_DEYE/total/battery_energy_out/state');
        const gridPowerInData = await getCurrentValue('solar_assistant_DEYE/total/grid_energy_in/state');
        const gridPowerOutData = await getCurrentValue('solar_assistant_DEYE/total/grid_energy_out/state');

        const loadPowerDataDaily = calculateDailyDifference(loadPowerData);
        const pvPowerDataDaily = calculateDailyDifference(pvPowerData);
        const batteryPowerInDataDaily = calculateDailyDifference(batteryPowerInData);
        const batteryPowerOutDataDaily = calculateDailyDifference(batteryPowerOutData);
        const gridPowerInDataDaily = calculateDailyDifference(gridPowerInData);
        const gridPowerOutDataDaily = calculateDailyDifference(gridPowerOutData);

        const hourlyData = loadPowerDataDaily.map((load, index) => ({
            hour: moment(load.time).format('HH'),
            load: load.value || 0,
            solar: (pvPowerDataDaily[index] && pvPowerDataDaily[index].value) || 0,
            battery: (batteryPowerOutDataDaily[index] && batteryPowerOutDataDaily[index].value) || 0,
            grid: (gridPowerInDataDaily[index] && gridPowerInDataDaily[index].value) || 0
        }));

        const data = {
            totalConsumption: loadPowerDataDaily.reduce((acc, load) => acc + (load.value || 0), 0),
            solarProduction: pvPowerDataDaily.reduce((acc, pv) => acc + (pv.value || 0), 0),
            gridIn: gridPowerInDataDaily.reduce((acc, grid) => acc + Math.max(grid.value || 0, 0), 0),
            gridOut: gridPowerOutDataDaily.reduce((acc, grid) => acc + Math.min(grid.value || 0, 0), 0),
            batteryCharged: batteryPowerInDataDaily.reduce((acc, battery) => acc + Math.max(battery.value || 0, 0), 0),
            batteryDischarged: batteryPowerOutDataDaily.reduce((acc, battery) => acc + Math.min(battery.value || 0, 0), 0),
            hourlyData
        };

        res.json(data);
    } catch (error) {
        console.error('Error fetching energy data:', error);
        res.status(500).json({ error: 'Error fetching energy data' });
    }
});

app.get('/analytics', async (req, res) => {
    try {
        const loadPowerData = await queryInfluxDB('solar_assistant_DEYE/total/load_energy/state');
        const pvPowerData = await queryInfluxDB('solar_assistant_DEYE/total/pv_energy/state');
        const batteryStateOfChargeData = await queryInfluxDB('solar_assistant_DEYE/total/battery_energy_in/state');
        const batteryPowerData = await queryInfluxDB('solar_assistant_DEYE/total/battery_energy_out/state');
        const gridPowerData = await queryInfluxDB('solar_assistant_DEYE/total/grid_energy_in/state');
        const gridVoltageData = await queryInfluxDB('solar_assistant_DEYE/total/grid_energy_out/state');

        const data = {
            loadPowerData,
            pvPowerData,
            batteryStateOfChargeData,
            batteryPowerData,
            gridPowerData,
            gridVoltageData,
        };

        res.render('analytics', { data, ingress_path: process.env.INGRESS_PATH || '' });
    } catch (error) {
        console.error('Error fetching analytics data from InfluxDB:', error);
        res.status(500).json({ error: 'Error fetching analytics data from InfluxDB' });
    }
});

app.get('/', async (req, res) => {
    try {
        const loadPower = await getCurrentData('solar_assistant_DEYE/total/load_power/state');
        const solarProduction = await getCurrentData('solar_assistant_DEYE/total/pv_power/state');
        const batteryStateOfCharge = await getCurrentData('solar_assistant_DEYE/total/battery_state_of_charge/state');
        const gridImport = await getCurrentData('solar_assistant_DEYE/total/grid_power/state');
        const gridVoltage = await getCurrentData('solar_assistant_DEYE/total/grid_voltage/state');

        const data = {
            loadPower,
            solarProduction,
            batteryStateOfCharge,
            gridImport,
            gridVoltage,
        };

        res.render('energy-dashboard', { data, ingress_path: process.env.INGRESS_PATH || '' });
    } catch (error) {
        console.error('Error fetching data from InfluxDB:', error);
        res.status(500).json({ error: 'Error fetching data from InfluxDB' });
    }
});

app.get('/api/realtime-data', async (req, res) => {
    try {
        const loadPower = await getCurrentData('solar_assistant_DEYE/total/load_power/state');
        const solarProduction = await getCurrentData('solar_assistant_DEYE/total/pv_power/state');
        const batteryStateOfCharge = await getCurrentData('solar_assistant_DEYE/total/battery_state_of_charge/state');
        const gridImport = await getCurrentData('solar_assistant_DEYE/total/grid_power/state');
        const gridVoltage = await getCurrentData('solar_assistant_DEYE/total/grid_voltage/state');

        const data = {
            loadPower,
            solarProduction,
            batteryStateOfCharge,
            gridImport,
            gridVoltage,
        };

        res.json(data);
    } catch (error) {
        console.error('Error fetching real-time data:', error);
        res.status(500).json({ error: 'Error fetching real-time data' });
    }
});

// Universal Settings
app.get('/api/universal-settings', (req, res) => {
    res.json(universalSettings);
});

app.post('/api/universal-settings', (req, res) => {
    universalSettings = { ...universalSettings, ...req.body };
    res.json(universalSettings);
    Object.entries(universalSettings).forEach(([key, value]) => {
        publishToMQTT(`solar_assistant_DEYE/universal/${key}`, value);
    });
});

// Inverter Settings
app.get('/api/inverter-types', (req, res) => {
    res.json(Object.keys(inverterConfig));
});

app.get('/api/inverter-settings', (req, res) => {
    res.json({ type: currentInverterType, settings: currentInverterSettings });
});

app.post('/api/inverter-settings', (req, res) => {
    const { type, settings } = req.body;
    if (inverterConfig[type]) {
        currentInverterType = type;
        currentInverterSettings = { ...inverterConfig[type], ...settings };
        inverterConfig[type] = currentInverterSettings;
        res.json({ type: currentInverterType, settings: currentInverterSettings });
        Object.entries(currentInverterSettings).forEach(([key, value]) => {
            publishToMQTT(`solar_assistant_DEYE/inverter/${key}`, value);
        });
    } else {
        res.status(400).json({ error: 'Invalid inverter type' });
    }
});

// Automation Rules
app.get('/api/automation-rules', (req, res) => {
    res.json(automationRules);
});

app.post('/api/automation-rules', (req, res) => {
    const newRule = {
        id: Date.now().toString(),
        name: req.body.name,
        conditions: req.body.conditions,
        actions: req.body.actions,
        days: req.body.days
    };
    automationRules.push(newRule);
    res.status(201).json(newRule);
});

app.put('/api/automation-rules/:id', (req, res) => {
    const { id } = req.params;
    const index = automationRules.findIndex(rule => rule.id === id);
    if (index !== -1) {
        automationRules[index] = { ...automationRules[index], ...req.body };
        res.json(automationRules[index]);
    } else {
        res.status(404).json({ error: 'Rule not found' });
    }
});

app.delete('/api/automation-rules/:id', (req, res) => {
    const { id } = req.params;
    automationRules = automationRules.filter(rule => rule.id !== id);
    res.sendStatus(204);
});

// Scheduled Settings
app.get('/api/scheduled-settings', (req, res) => {
    res.json(scheduledSettings);
});

app.post('/api/scheduled-settings', (req, res) => {
    const newSetting = {
        id: Date.now().toString(),
        key: req.body.key,
        value: req.body.value,
        day: req.body.day,
        hour: req.body.hour
    };
    scheduledSettings.push(newSetting);
    res.status(201).json(newSetting);
});

app.put('/api/scheduled-settings/:id', (req, res) => {
    const { id } = req.params;
    const index = scheduledSettings.findIndex(setting => setting.id === id);
    if (index !== -1) {
        scheduledSettings[index] = { ...scheduledSettings[index], ...req.body };
        res.json(scheduledSettings[index]);
    } else {
        res.status(404).json({ error: 'Scheduled setting not found' });
    }
});

app.delete('/api/scheduled-settings/:id', (req, res) => {
    const { id } = req.params;
    scheduledSettings = scheduledSettings.filter(setting => setting.id !== id);
    res.sendStatus(204);
});

// MQTT publishing route
app.post('/api/mqtt', (req, res) => {
    const { topic, message } = req.body;
    publishToMQTT(topic, message);
    res.sendStatus(200);
});

// Helper functions
function filterMessagesByCategory(category) {
    if (category && category !== 'all') {
        return incomingMessages.filter(message => {
            const keywords = getCategoryKeywords(category);
            return keywords.some(keyword => message.includes(keyword));
        });
    }
    return incomingMessages;
}

function getCategoryKeywords(category) {
    switch (category) {
        case 'inverter1':
            return ['inverter_1'];
        case 'inverter2':
            return ['inverter_2'];
        case 'loadPower':
            return ['load_power'];
        case 'gridPower':
            return ['grid_power'];
        default:
            return [];
    }
}

function publishToMQTT(topic, message) {
    let messageToSend = message;
    if (typeof message === 'number' && isNaN(message)) {
        console.warn(`Attempting to publish NaN value to ${topic}. Skipping.`);
        return;
    }
    if (typeof message !== 'string') {
        messageToSend = JSON.stringify(message);
    }

    mqttClient.publish(topic, messageToSend, (err) => {
        if (err) {
            console.error('Error publishing to MQTT:', err);
        } else {
            console.log(`Published to ${topic}: ${messageToSend}`);
            broadcastMessage({
                type: 'automationLog',
                message: `Published to ${topic}: ${messageToSend}`
            });
        }
    });
}

function applyScheduledSettings() {
    const now = new Date();
    const day = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][now.getDay()];
    const hour = now.getHours();

    scheduledSettings.forEach(setting => {
        if (setting.day === day && setting.hour === hour) {
            publishToMQTT(`solar_assistant_DEYE/${setting.key}`, setting.value);
            broadcastMessage({
                type: 'realtimeUpdate',
                updateType: 'scheduledSettingApplied',
                key: setting.key,
                value: setting.value
            });
        }
    });
}

function applyAutomationRules() {
    const now = new Date();
    const day = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][now.getDay()];

    automationRules.forEach(rule => {
        if (rule.days.includes(day) && checkConditions(rule.conditions)) {
            rule.actions.forEach(action => {
                publishToMQTT(`solar_assistant_DEYE/${action.key}`, action.value);
            });
            broadcastMessage({
                type: 'realtimeUpdate',
                updateType: 'automationRuleTriggered',
                ruleName: rule.name,
                actions: rule.actions
            });
        }
    });
}

function checkConditions(conditions) {
    return conditions.every(condition => {
        const { deviceType, parameter, operator, value } = condition;
        
        if (currentSystemState[deviceType] && currentSystemState[deviceType][parameter] !== undefined) {
            return compareNumeric(currentSystemState[deviceType][parameter], operator, parseFloat(value));
        } else if (currentSystemState[parameter] !== undefined) {
            return compareNumeric(currentSystemState[parameter], operator, parseFloat(value));
        }
        
        console.warn(`Unknown parameter: ${deviceType}.${parameter}`);
        return false;
    });
}

function compareNumeric(actual, operator, expected) {
    switch (operator) {
        case 'equals':
            return Math.abs(actual - expected) < 0.001;
        case 'notEquals':
            return Math.abs(actual - expected) >= 0.001;
        case 'greaterThan':
            return actual > expected;
        case 'lessThan':
            return actual < expected;
        case 'greaterThanOrEqual':
            return actual >= expected;
        case 'lessThanOrEqual':
            return actual <= expected;
        default:
            console.warn(`Unknown operator: ${operator}`);
            return false;
    }
}

// WebSocket setup
const server = app.listen(port, '0.0.0.0', () => {
    console.log(`Server is running on http://0.0.0.0:${port}`);
    connectToMqtt();
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    console.log('Client connected');
    ws.on('close', () => console.log('Client disconnected'));
});

function broadcastMessage(message) {
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(message));
        }
    });
}

// Scheduled tasks
setInterval(applyScheduledSettings, 60000); // Run every minute
setInterval(applyAutomationRules, 60000); // Run every minute

// Error handling middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Something went wrong!' });
});

// 404 handler
app.use((req, res, next) => {
    res.status(404).send("Sorry, that route doesn't exist.");
});

module.exports = { app, server };