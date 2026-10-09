'use strict';

const Homey = require('homey');
const { HomeyAPI } = require('homey-api');

const API_INIT_TIMEOUT_MS = 10000;
const API_RETRY_DELAY_MS = 60000;

class EVChargingPredictorApp extends Homey.App {

  async onInit() {
    this.log('EV Charging Predictor starting');

    let resolveApiReady;
    this.apiReadyPromise = new Promise((resolve) => { resolveApiReady = resolve; });
    this._resolveApiReady = resolveApiReady;

    await this._initApi();
  }

  async _initApi() {
    if (this._apiRetryTimer) {
      this.homey.clearTimeout(this._apiRetryTimer);
      this._apiRetryTimer = null;
    }

    let timeoutTimer = null;
    try {
      this.api = await Promise.race([
        HomeyAPI.createAppAPI({ homey: this.homey }),
        new Promise((_, reject) => {
          timeoutTimer = this.homey.setTimeout(() => reject(new Error('HomeyAPI.createAppAPI timed out')), API_INIT_TIMEOUT_MS);
        }),
      ]);
      this.log('HomeyAPI connected');
      this._resolveApiReady();
    } catch (err) {
      this.error('HomeyAPI init failed, retrying in 60s:', err.message);
      this._apiRetryTimer = this.homey.setTimeout(() => this._initApi(), API_RETRY_DELAY_MS);
    } finally {
      this.homey.clearTimeout(timeoutTimer);
    }
  }

}

module.exports = EVChargingPredictorApp;
