// config/inverterSettings.js

module.exports = {
    DEYE: {
      workModes: ['Selling first', 'Zero Export to Load', 'Selling first'],
      solarExportWhenBatteryFull: true,
      energyPatterns: ['Load First', 'Battery First'],
      maxSellPower: 5000
    },
    MPP: {
      // Add MPP-specific settings here
    }
    // Add other inverter brands as needed
  };