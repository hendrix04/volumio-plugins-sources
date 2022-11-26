'use strict';

const libQ = require('kew');
const fs = require('fs-extra');
const io = require('socket.io-client');
const eiscp = require('eiscp');

module.exports = onkyoControl;

function onkyoControl(context) {
    const self = this;

    self.context = context;
    self.commandRouter = self.context.coreCommand;
    self.logger = self.context.logger;
    self.configManager = self.context.configManager;

    self.zoneList = [];
    self.receivers = {};
    self.connectionOptions = {
        reconnect: true,
        verify_commands: false
    };
    self.musicState = 'stopped';
    self.receiverState = 'off';
    self.volume = 0;
    self.logger.transports[0].level = "debug";
    self.logger.debug("ONKYO - Initial Setup");
}

onkyoControl.prototype.validConnectionOptions = function () {

    const self = this;
    self.logger.debug("ONKYO - In validConnectionOptions");

    if (
        self.connectionOptions.hasOwnProperty('port')
        && typeof self.connectionOptions.port === 'number'
        && self.connectionOptions.hasOwnProperty('host')
        && typeof self.connectionOptions.host === 'string'
    ) {
        self.logger.debug("ONKYO - Valid connection found");
        return true;
    }
    
    self.logger.debug("ONKYO - No valid connections");
    return false;

}

onkyoControl.prototype.updateZoneList = function() {
    const self = this;

    self.logger.debug("ONKYO - Generating zone list");
    self.zoneList.length = 0;

    Object.keys(eiscp.get_model_commands(self.connectionOptions.model)).forEach(zone => {
        self.logger.debug(`ONKYO - Adding zone: ${zone}`);
        self.zoneList.push(zone);
    });
}

onkyoControl.prototype.onVolumioStart = function () {
    const self = this;
    self.logger.debug(`ONKYO - Start Volumio Starting`);
    const configFile = this.commandRouter.pluginManager.getConfigurationFile(this.context, 'config.json');
    this.config = new (require('v-conf'))();
    self.logger.debug("ONKYO-CONTROL:  CONFIG FILE: " + configFile);
    this.config.loadFile(configFile);

    self.load18nStrings();
    self.logger.debug(`ONKYO - Finished Volumio Starting`);
    return libQ.resolve();
}

onkyoControl.prototype.onStart = function () {
    const self = this;
    const defer = libQ.defer();

    self.logger.debug(`ONKYO - Starting Plugin`);
    self.socket = io.connect('http://localhost:3000');

    // Discover what receivers are available
    eiscp.discover({timeout: 5}, function (err, results) {
        if (err) {
            self.logger.error("ONKYO-CONTROL: Error discovering receivers: " + results);
        }
        else {
            self.logger.debug("ONKYO-CONTROL: Found these receivers on the local network: " + JSON.stringify(results));

            // Apparently even if no receivers are discovered, we still get into this area.
            // I try to mitigate this but wrapping in a try / catch just in case.
            try {
                results.forEach(function (receiver) {
                    self.receivers[receiver.mac] = {
                        "host": receiver.host,
                        "model": receiver.model,
                        "mac": receiver.mac,
                        "port": parseInt(receiver.port)
                    };
                });

                if (results.length > 0) {
                    const firstReceiver = Object.values(self.receivers)[0];

                    if (self.config.get('autoDiscovery')) {
                        self.connectionOptions.port = parseInt(firstReceiver.port);
                        self.connectionOptions.host = firstReceiver.host;
                        self.connectionOptions.model = firstReceiver.model;
                    }
                    else {
                        self.connectionOptions.port = parseInt(self.config.get('receiverPort', firstReceiver.port));
                        self.connectionOptions.host = self.config.get('receiverIP', firstReceiver.host);
                        self.connectionOptions.model = self.config.get('receiverModel', firstReceiver.model);
                    }
                }
                else if (
                    ! self.config.get('autoDiscovery')
                    && self.config.get('receiverPort')
                    && self.config.get('receiverIP')
                ) {
                    self.connectionOptions.port = parseInt(self.config.get('receiverPort'));
                    self.connectionOptions.host = self.config.get('receiverIP');
                    self.connectionOptions.model = self.config.get('receiverModel');
                }
                else {
                    self.commandRouter.pushToastMessage("info", "No Onkyo receivers found. Please manually configure.");
                }
                

                if (self.validConnectionOptions()) {
                    // Figure out the available zones
                    self.updateZoneList();

                    // Now that we have our connection options completed, let's connect.
                    // We will want to disconnect and reconnect if the receiver option changes.
                    self.logger.debug(`ONKYO - Connecting to receiver`);
                    eiscp.connect(self.connectionOptions);

                    self.logger.debug(`ONKYO - Triggering onState event`);
                    // Fire off a message to get an initial state back from the backend.
                    self.socket.emit("getState");
                }
            }
            catch (error) {
                self.commandRouter.pushToastMessage("info", "No Onkyo receivers found. Please manually configure.");
            }

            // Since this is a callback and the rest of the on start is synchronous,
            // consider this the end of the start function.
            self.logger.info("ONKYO-CONTROL: *********** ONKYO PLUGIN STARTED ********");
            defer.resolve();
        }
    });

    eiscp.on('error', function (error) {
        self.logger.error("ONKYO-CONTROL:  An error occurred trying to comminicate with the receiver: " + error);
    });

    self.socket.on('pushState', function (state) {
        self.logger.debug(`ONKYO - State change`);
        if (self.validConnectionOptions()) {

            self.logger.debug("ONKYO-CONTROL: *********** ONKYO PLUGIN STATE CHANGE ********");
            self.logger.info("ONKYO-CONTROL: New state: " + JSON.stringify(state) + " connection: " + JSON.stringify(self.connectionOptions));

            let waitToSend = 0;
            if (!eiscp.is_connected) {
                self.logger.debug(`ONKYO - Not connected to receiver, trying to connect`);
                eiscp.connect(self.connectionOptions);
                waitToSend = 500;
            }

            if (state.status !== self.musicState) {
                self.logger.debug(`ONKYO - status has changed to ${state.status}`);
                self.musicState = state.status;

                switch (self.musicState) {
                    case 'play':
                        // We only want to turn things on if music is playing and
                        // the reveiver has yet to be turned on.
                        if (self.receiverState === 'off') {
                            self.logger.debug(`ONKYO - receiverState is off`);
                            if (self.config.get('powerOn')) {
                                self.logger.debug(`ONKYO - Turning on receiver`);
                                self.callReceiver({
                                    "action": 'power',
                                    "value": 'on',
                                    "waitToSend": waitToSend,
                                });
                                self.logger.debug(`ONKYO - Back from sending turn on command`);
                            }

                            if (self.config.get('setVolume')) {
                                self.logger.debug(`ONKYO - Setting volume of receiver for initial turn on`);
                                const volume = self.config.get('setVolumeValue', self.config.get('maxVolume', 100));
                                self.volume = volume;

                                // Let's tell the backend what the volume should be
                                // as well so that we can stay in sync. Typically
                                // after this first set, we shouldn't need to set
                                // it again.
                                self.logger.debug(`ONKYO - telling Volumio what the volume should be`);
                                self.socket.emit("volume", self.volume);

                                self.logger.debug(`ONKYO - Calling receiver to set volume`);
                                self.callReceiver({
                                    "action": 'volume',
                                    "value": self.volume,
                                    "waitToSend": waitToSend,
                                });
                                self.logger.debug(`ONKYO - finished setting the volume`);
                            }

                            if (self.config.get('setInput')) {
                                self.logger.debug(`ONKYO - setting input to ${self.config.get('setInputValue')}`);
                                self.callReceiver({
                                    "action": 'selector',
                                    "value": self.config.get('setInputValue'),
                                    "waitToSend": waitToSend,
                                });
                                self.logger.debug(`ONKYO - Finished setting input`);
                            }
                            self.logger.debug(`ONKYO - setting receiver state to on.`);
                            self.receiverState = 'on';
                        }

                        break;
                    case 'stop':
                    case 'pause':

                        if (self.config.get('standby', true)) {
                            self.logger.debug(`ONKYO - Potentially turn off receiver`);
                            if (self.receiverState === 'on') {
                                self.logger.debug(`ONKYO - Decided that we should turn off receiver`);
                                setTimeout(() => {
                                    self.logger.debug(`ONKYO - Waited our timeout for turning off receiver`);
                                    // Every time we pause or stop music, we will
                                    // call into the function based on our turn off
                                    // delay setting. This will stop us from
                                    // accidentally turning the system off if we
                                    // are still using it.
                                    if (self.musicState !== 'play' && self.receiverState === 'on') {
                                        self.logger.debug(`ONKYO - Decided that we should still turn off the receiver`);
                                        // Update our receiver state so that if we
                                        // do start playing music again, we can
                                        // turn things back on.
                                        self.receiverState = 'off';
                                        self.callReceiver({
                                            "action": 'power',
                                            "value": 'standby',
                                            "waitToSend": waitToSend,
                                        });
                                        self.logger.debug(`ONKYO - Finished the call to turn off receiver`);
                                    }
                                }, self.config.get('standbyDelay') * 1000);
                            }
                        }

                        break;
                    default:
                        break;
                }
            }
            else {
                // Throwing this in an else so that we don't accidentally
                // overwrite the initial play volume.
                if (self.receiverState === 'on' && self.volume !== state.volume) {
                    self.logger.debug(`ONKYO - Receiver is on and we should change the volume`);
                    const maxVolume = self.config.get('maxVolume', 100);
                    self.volume = (state.volume) > maxVolume ? maxVolume : state.volume;
                    self.logger.debug(`ONKYO - Making call to change volume on volume change`);
                    self.callReceiver({
                        "action": 'volume',
                        "value": self.volume,
                        "waitToSend": waitToSend,
                    });
                    self.logger.debug(`ONKYO - Finished volume change call`);
                }
            }
        }
    });

    self.logger.debug(`ONKYO - Falling out of on start with a hanging promise.`);
    return defer.promise;
};

onkyoControl.prototype.onStop = function () {
    var self = this;
    var defer = libQ.defer();

    self.running = false;
    self.logger.info("ONKYO-CONTROL: *********** ONKYO PLUGIN STOPPED ********");

    if (eiscp.is_connected) {
        eiscp.disconnect();
    }
    self.socket.disconnect();

    // Once the Plugin has successfull stopped resolve the promise
    defer.resolve();

    return libQ.resolve();
};

onkyoControl.prototype.getConfigurationFiles = function () {
    return ['config.json'];
}

// Configuration Methods -----------------------------------------------------------------------------

onkyoControl.prototype.refreshUIConfig = function() {
    let self = this;

    self.logger.debug(`ONKYO - Refreshing config UI`);

    self.commandRouter.getUIConfigOnPlugin('system_hardware', 'onkyo_control', {}).then( config => {
        self.commandRouter.broadcastMessage('pushUiConfig', config);
    });

    self.logger.debug(`ONKYO - Done refreshing config UI`);
}

onkyoControl.prototype.getUIConfig = function () {
    var defer = libQ.defer();
    var self = this;
    self.logger.debug(`ONKYO - Start UI config`);
    var lang_code = this.commandRouter.sharedVars.get('language_code');

    self.commandRouter.i18nJson(__dirname + '/i18n/strings_' + lang_code + '.json',
        __dirname + '/i18n/strings_en.json',
        __dirname + '/UIConfig.json')
        .then( async (uiconf) => {
            self.logger.debug("ONKYO-CONTROL: getUIConfig()");
            self.logger.debug(`ONKYO - Start setting values for UI`);
            uiconf.sections[0].content[0].value = self.config.get('autoDiscovery', true);
            uiconf.sections[0].content[2].value = self.config.get('receiverIP');
            uiconf.sections[0].content[3].value = self.config.get('receiverPort');
            uiconf.sections[0].content[4].value = self.config.get('receiverModel');

            uiconf.sections[1].content[0].value = self.config.get('zone', 'main');
            uiconf.sections[1].content[1].value = self.config.get('powerOn', true);
            uiconf.sections[1].content[2].value = self.config.get('maxVolume', 100);
            uiconf.sections[1].content[3].value = self.config.get('setVolume', false);
            uiconf.sections[1].content[4].value = self.config.get('setVolumeValue');
            uiconf.sections[1].content[5].value = self.config.get('setInput', false);
            uiconf.sections[1].content[7].value = self.config.get('standby', true);
            uiconf.sections[1].content[8].value = self.config.get('standbyDelay');

            self.logger.debug(`ONKYO - Iterate Receivers`);
            for (const [key, receiver] of Object.entries(self.receivers)) {

                const receiverValue = `${receiver.host}_${receiver.model}_${key}_${receiver.port}`;
                self.logger.debug(`ONKYO - Receiver ID ${receiverValue}`);
                var option = {
                    "value": receiverValue,
                    "label": receiver.model + " : " + key
                };
                uiconf.sections[0].content[1].options.push(option);

                if (receiverValue === self.config.get('receiverSelect')) {
                    uiconf.sections[0].content[1].value = option;
                }
            }

            if (!uiconf.sections[0].content[1].value) {
                uiconf.sections[0].content[1].value = {
                    "value": "manual",
                    "label": self.getI18nString("SELECT_RECEIVER_MANUAL")
                };
            }
            self.logger.debug(`ONKYO - Adding Zones`);
            // Because I hate copy / pasting code and because JS
            // will let me do silly things...
            function setZoneOption(zone, selectedZone) {
                self.logger.debug(`ONKYO - ${zone} : ${selectedZone}`);

                // Removing the "dock" zone. No clue what it is, but if
                // anyone is looking at this in the future and wants it,
                // let me know.
                if (zone !== 'dock') {
                    const option = {"value": zone, "label": zone};

                    uiconf.sections[1].content[0].options.push(option);

                    if (zone === selectedZone) {
                        uiconf.sections[1].content[0].value = option;
                    }
                }
            }

            if (self.zoneList.length > 0) {
                self.logger.debug(`ONKYO - zoneList is populated`);
                const selectedZone = self.config.get('zone', 'main');

                self.zoneList.forEach(zone => {
                    setZoneOption(zone, selectedZone);
                });
            }
            else {
                self.logger.debug(`ONKYO - zoneList is not populated`);
                setZoneOption('main', 'main');
            }
            self.logger.debug(`ONKYO - Getting inputs for receiver`);
            eiscp.get_command('input-selector', function (err, results) {
                self.logger.debug(`ONKYO - Inputs returned`);
                results.forEach(function (input) {
                    const option = {"value": input, "label": input};
                    uiconf.sections[1].content[6].options.push(option);

                    if (input === self.config.get('setInputValue')) {
                        uiconf.sections[1].content[6].value = option;
                    }
                });
            });
            self.logger.debug(`ONKYO - Finished UI settings`);
            defer.resolve(uiconf);
        })
        .fail(function () {
            self.logger.debug(`ONKYO - Something failed in UI settings`);
            defer.reject(new Error());
        });

    self.logger.debug(`ONKYO - UI load finish, promise still outstanding`);
    return defer.promise;
};

onkyoControl.prototype.saveConnectionConfig = function (data) {
    var self = this;

    self.logger.debug(`ONKYO - Saving connection config`);
    self.logger.debug("ONKYO-CONTROL: saveConnectionConfig() data: " + JSON.stringify(data));
    self.config.set('autoDiscovery', data['autoDiscovery']);
    self.config.set('receiverSelect', data['receiverSelect'].value);
    const newValues = {};

    if (data['receiverSelect'].value !== "manual") {
        self.logger.debug(`ONKYO - Manual input not selected`);
        /*
            Split up the receiverSelect into its parts
            0: host / ip
            1: model
            2: mac
            3: port
        */
        self.logger.debug(`ONKYO - Splitting input ${data['receiverSelect']}`);
        const valueParts = data['receiverSelect'].value.split('_');
        

        self.config.set('receiverIP', valueParts[0]);
        self.config.set('receiverPort', valueParts[3]);
        self.config.set('receiverModel', valueParts[1]);
        newValues.host = valueParts[0];
        newValues.port = valueParts[3];
        newValues.model = valueParts[1];
    }
    else {
        self.logger.debug(`ONKYO - Manual input selected`);
        self.config.set('receiverIP', data['receiverIP']);
        self.config.set('receiverModel', data['receiverModel']);
        newValues.host = data['receiverIP'];
        newValues.model = data['receiverModel'];

        if (!data['receiverPort'] || data['receiverPort'] === '' || isNaN(data['receiverPort'])) {
            self.config.set('receiverPort', '60128');
            newValues.port = '60128';
        }
        else {
            self.config.set('receiverPort', data['receiverPort']);
            newValues.port = data['receiverPort'];
        }
    }

    if (!(newValues.host --- self.connectionOptions.host)) {
        self.logger.debug(`ONKYO - Connection host has changed`);
        self.logger.debug(`ONKYO - Old connection ${JSON.stringify(self.connectionOptions)}`);
        self.connectionOptions.host = newValues.host;
        self.connectionOptions.port = parseInt(newValues.port);
        self.connectionOptions.model = newValues.model;
        self.logger.debug(`ONKYO - New connection ${JSON.stringify(self.connectionOptions)}`);
        self.logger.debug(`ONKYO - Update zones based on new information`);
        // Update Zone list
        self.updateZoneList();

        if (eiscp.is_connected) {
            self.logger.debug(`ONKYO - Closing old connection`);
            eiscp.close();
        }

        self.logger.debug(`ONKYO - Creating new connection`);
        eiscp.connect(self.connectionOptions);
    }
    self.logger.debug(`ONKYO - Finished saving connection information`);
    self.commandRouter.pushToastMessage('success', self.getI18nString("SETTINGS_SAVED"), self.getI18nString("SETTINGS_SAVED_CONNECTION"));
    self.refreshUIConfig();

    return 1;
};

onkyoControl.prototype.saveActionConfig = function (data) {
    var self = this;

    self.logger.debug(`ONKYO - saving action config`);
    self.logger.debug("ONKYO-CONTROL: saveActionConfig() data: " + JSON.stringify(data));

    self.config.set('powerOn', data['powerOn']);
    self.config.set('standby', data['standby']);
    self.config.set('zone', data['zone'].value);

    if (data['standbyDelay'] <= 0) {
        self.config.set('standbyDelay', 0);
    }
    else {
        self.config.set('standbyDelay', data['standbyDelay']);
    }

    self.config.set('setVolume', data['setVolume']);

    if (data['setVolumeValue'] <= 0) {
        self.config.set('setVolumeValue', 0);
    }
    else {
        self.config.set('setVolumeValue', data['setVolumeValue']);
    }

    if (data['maxVolume'] <= 0) {
        self.config.set('maxVolume', 0);
    }
    else {
        self.config.set('maxVolume', data['maxVolume']);
    }

    self.config.set('setInput', data['setInput']);
    if (data['setInputValue']) {
        self.config.set('setInputValue', data['setInputValue'].value);
    }
    else {
        self.config.set('setInputValue', 'line1');
    }

    self.commandRouter.pushToastMessage('success', self.getI18nString("SETTINGS_SAVED"), self.getI18nString("SETTINGS_SAVED_ACTION"));

    self.logger.debug(`ONKYO - done saving actions`);
    return 1;
};

// Internationalisation Methods -----------------------------------------------------------------------------

onkyoControl.prototype.load18nStrings = function () {
    var self = this;

    try {
        var language_code = this.commandRouter.sharedVars.get('language_code');
        self.i18nStrings = fs.readJsonSync(__dirname + '/i18n/strings_' + language_code + ".json");
    }
    catch (e) {
        self.i18nStrings = fs.readJsonSync(__dirname + '/i18n/strings_en.json');
    }

    self.i18nStringsDefaults = fs.readJsonSync(__dirname + '/i18n/strings_en.json');
};

onkyoControl.prototype.getI18nString = function (key) {
    var self = this;

    if (self.i18nStrings[key] !== undefined) {
        return self.i18nStrings[key];
    }
    else {
        return self.i18nStringsDefaults[key];
    }
};

onkyoControl.prototype.callReceiver = function (args) {
    const self = this;

    self.logger.debug(`ONKYO - calling receiver with args: ${JSON.stringify(args)}`);
    // First make sure we have valid connection info.
    if (self.validConnectionOptions()) {
        self.logger.debug(`ONKYO - Connection options are valid - ${JSON.stringify(self.connectionOptions)}`);

        /*
            If we aren't connected, wait 500ms to see if we connect.
            If we still aren't connected, wait 5000ms and try again.
            If we still aren't connected, give up.
        */

        if (!eiscp.is_connected && args.waitToSend <= 5000) {
            self.logger.debug(`ONKYO - Not connected, adding delay`);

            const waitToSend = (args.waitToSend === 500) ? 5000 : 9999;
            setTimeout(() => {
                self.callReceiver({
                    "action": args.action,
                    "value": args.value,
                    "waitToSend" : waitToSend,
                });
            }, args.waitToSend);
        }
        else if (eiscp.is_connected) {
            self.logger.debug(`ONKYO - Connected, sending command`);
            const zone = self.config.get('zone', 'main');
            /*
                Onkyo expects volume to be in the range of 0 - 200. To make it easier
                for users, we will do a conversion here before sending it out.

                If this becomes something that is a habit, we should refactor this a bit
                for now since only volume needs to be manipulated for every call, we
                will leave it here.
            */
            args.value = (args.action === 'volume') ? args.value * 2 : args.value;
            self.logger.debug(`ONKYO COMMAND: ${zone}.${args.action}=${args.value}`);
            eiscp.command(`${zone}.${args.action}=${args.value}`);
        }
        
        if (!eiscp.is_connected) {

            self.logger.debug(`ONKYO - Not connected, attempting to connect`);
            // Give up, there is no more
            self.logger.error("ONKYO-CONTROL: Error sending command. Not Connected");

            // For giggles, try one more time to connect.
            eiscp.connect(self.connectionOptions);
        }
    }
}
