/**
 * ioBroker HEOS Adapter
 * Copyright (c) 2021 withstu <withstu@gmx.de>
 * MIT License
 */
'use strict';

const { URL } = require('url');
const got = require('got');
const {decode} = require('html-entities');

const parser = require('fast-xml-parser');
const converter = new parser.j2xParser({
	attributeNamePrefix: '@',
	ignoreAttributes: false
});

const USER_AGENT = 'LINUX UPnP/1.0 Denon-Heos/149200';

class HeosUPnP {
	/**
	 * @param {string} ip IP address of player
	 */
	constructor(ip){
		this.ip = ip;
		this.url = 'http://' + this.ip + ':60006/upnp/desc/aios_device/aios_device.xml';
		this.client = got.extend({
			headers: {
			  'user-agent': USER_AGENT
			}
		});
	}

	async init() {
		const response = await this.client(this.url);
		const device = parser.parse(response.body, { parseTrueNumberOnly: true }).root.device;

		this.deviceType = device.deviceType;
		this.friendlyName = device.friendlyName;
		this.manufacturer = device.manufacturer;
		this.manufacturerURL = device.manufacturerURL;
		this.modelName = device.modelName;
		this.modelNumber = device.modelNumber;
		this.serialNumber = device.serialNumber;
		this.UDN = device.UDN;
		this.services = {};
		this.devices = await this.parseDevices(device.deviceList.device);
	}

	async parseDevices(rawdevices){
		const devices = {};

		for (const rawdevice of rawdevices) {
			const device = rawdevice;
			const id = rawdevice.deviceType.split(':')[3];
			device.services = await this.parseServices(device.serviceList.service);
			devices[id] = device;
		}
		return devices;
	}

	async parseServices(rawservices){
		const services = {};

		if(!Array.isArray(rawservices)){
			rawservices = [rawservices];
		}
		for (const rawservice of rawservices) {
			const service = rawservice;
			const that = this;
			for (const key of Object.keys(service)) {
				if(key.includes('URL')){
					service[key] = that.absoluteUrl(that.url, service[key]);
				}
			}
			const id = service.serviceType.split(':')[3];

			const response = await this.client(service.SCPDURL);
			const serviceDefinition = await parser.parse(response.body, { parseTrueNumberOnly: true }).scpd;
			service.actions = await this.parseActions(serviceDefinition);

			services[id] = service;
			that.services[id] = service;
		}
		return services;
	}

	async parseActions(rawactions){
		const stateTable = {};
		const actions = {};

		for (const variable of rawactions.serviceStateTable.stateVariable) {
			if('allowedValueList' in variable){
				variable.allowedValues = variable.allowedValueList.allowedValue;
			}
			stateTable[variable.name] = variable;
		}

		for (const rawaction of rawactions.actionList.action) {
			const action = {};
			action.name = rawaction.name;

			action.argIn = [];
			action.argOut = [];

			if('argumentList' in rawaction){
				if(!Array.isArray(rawaction.argumentList.argument)){
					rawaction.argumentList.argument = [rawaction.argumentList.argument];
				}
				for (const arg of rawaction.argumentList.argument) {
					const stateVariable = stateTable[arg.relatedStateVariable];
					await Object.keys(stateVariable).forEach(async key => {
						if(key != 'name') {
							arg[key] = stateVariable[key];
						}
					});
					if(arg.direction === 'in'){
						action.argIn.push(arg);
					} else {
						action.argOut.push(arg);
					}
				}
			}
			actions[rawaction.name] = action;
		}

		return actions;
	}

	getServiceList(){
		return Object.keys(this.services);
	}

	hasService(p_service){
		return (this.services && (p_service in this.services));
	}

	getService(p_service) {
		if(!this.hasService(p_service)){
			throw Error('service ' + p_service + ' not found');
		}
		return this.services[p_service];
	}

	getServiceActionList(p_service){
		const service = this.getService(p_service);
		return Object.keys(service.actions);
	}

	hasServiceAction(p_service, p_action) {
		if(this.hasService(p_service)){
			const service = this.getService(p_service);
			return (service.actions && (p_action in service.actions));
		}
		return false;
	}

	getServiceAction(p_service, p_action){
		const service = this.getService(p_service);
		if(!this.hasServiceAction(p_service, p_action)){
			throw Error('action ' + p_action + ' not found');
		}
		return service.actions[p_action];
	}

	async sendCommand(p_service, p_action, data){
		if(!this.services){
			await this.init();
		}
		const service = this.getService(p_service);
		const action = this.getServiceAction(p_service, p_action);
		for (const arg of action.argIn) {
			if(!(arg.name in data)){
				throw Error('missing parameter: ' + arg.name);
			}
		}
		const soapBody = this.getSOAPBody(service, action, data);

		const res = await this.client({
			throwHttpErrors: false,
			url: service.controlURL,
			method: 'POST',
			body: soapBody,
			headers: {
				'Content-Type': 'text/xml; charset="utf-8"',
				'Content-Length': soapBody.length,
				'Connection': 'close',
				'SOAPACTION': `"${service.serviceType}#${action.name}"`
			}
		});

		if (res.statusCode !== 200) {
			throw Error('soap command ' + action.name + ' failure: ' + res.statusCode);
		}

		const result = this.parseSOAPResponse(res.body, action.name, action.argOut);

		for(const key in result){
			if(typeof result[key].includes === 'function'
				&& result[key].includes('&lt;')){
				result[key] = parser.parse(decode(result[key]), {
					parseTrueNumberOnly: true,
					ignoreAttributes: false,
					parseAttributeValue: true,
					ignoreNameSpace: true,
					attributeNamePrefix : '@_',
					textNodeName : 'value'
				});
			}
		}

		if('CurrentState' in result){
			let state = result['CurrentState'];
			if('Event' in state){
				if('InstanceID' in state['Event']){
					state = state['Event']['InstanceID'];
					delete state['@_val'];
				} else {
					state = state['Event'];
				}
			}
			for(const key in state){
				if(state[key]['@_val']
					&& typeof state[key]['@_val'].includes === 'function'
					&& state[key]['@_val'].includes('&lt;')){
					state[key]['@_val'] = parser.parse(decode(state[key]['@_val']).replace(/&quot;/g,''), {
						parseTrueNumberOnly: true,
						ignoreAttributes: false,
						parseAttributeValue: true,
						ignoreNameSpace: true,
						attributeNamePrefix : '@_',
						textNodeName : 'value'
					});
					if('DIDL-Lite' in state[key]['@_val']){
						state[key]['@_val'] = state[key]['@_val']['DIDL-Lite']['item'];
					}
				}
			}
			result['CurrentState'] = state;
		}
		for(const key in result){
			if(typeof result[key] === 'object'
				&& 'DIDL-Lite' in result[key]){
				result[key] = JSON.parse(JSON.stringify(result[key]['DIDL-Lite']['item']).replace(/&quot;/g,''));
			}
		}

		return result;
	}

	parseSOAPResponse(xmlString, action, outputs) {
		const envelope = parser.parse(xmlString);
		const res = envelope['s:Envelope']['s:Body'][`u:${action}Response`];
		return outputs.reduce((a, { name }) => {
			a[name] = res[name];
			return a;
		}, {});
	}

	getArguments(data) {
		if (!data) {
			return {};
		}
		return Object.keys(data).reduce((a, name) => {
			const value = data[name];
			if (value !== undefined) {
				a[name] = (value === null) ? '' : value.toString();
			}
			return a;
		}, {});
	}

	getSOAPBody(service, action, data) {
		const envelope = {
			's:Envelope': {
				'@xmlns:s': 'http://schemas.xmlsoap.org/soap/envelope/',
				'@s:encodingStyle': 'http://schemas.xmlsoap.org/soap/encoding/',
				's:Body': {
					[`u:${action.name}`]: {
						'@xmlns:u': service.serviceType,
						...this.getArguments(data)
					}
				}
			}
		};
		return converter.parse(envelope);
	}

	absoluteUrl(baseUrl, url) {
		return new URL(url, baseUrl).toString();
	}
}

module.exports = HeosUPnP;