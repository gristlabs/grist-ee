import {ActivationState} from 'app/common/gristUrls';
import {isAffirmative} from 'app/common/gutil';
import {Activation} from 'app/gen-server/entity/Activation';
import {ActivationsManager} from 'app/gen-server/lib/ActivationsManager';
import {getGlobalConfig} from 'app/server/lib/globalConfig';
import {Features} from 'app/common/Features';
import log from 'app/server/lib/log';

import * as fs from 'fs';
import * as jwt from 'jsonwebtoken';
import moment, {MomentInput} from 'moment';
import {EntityManager} from 'typeorm';

/**
 * Export dependencies to allow dynamic changes with unit tests.
 * Proxy process.env to allow behaviour changes without explicitly depending on this file.
 */
export const Deps = {
  get GRIST_ACTIVATION() {
    return process.env.GRIST_ACTIVATION;
  },
  get GRIST_ACTIVATION_FILE() {
    return process.env.GRIST_ACTIVATION_FILE;
  },
  get GRIST_FORCE_ENABLE_ENTERPRISE() {
    return process.env.GRIST_FORCE_ENABLE_ENTERPRISE;
  },
  get GRIST_CONFIG_IS_ENTERPRISE() {
    return getGlobalConfig().edition.get() === 'enterprise';
  },
  get GRIST_CHECK_ACTIVATION_INTERVAL() {
    return process.env.GRIST_CHECK_ACTIVATION_INTERVAL;
  }
};

export const isRunningEnterprise = () => {
  if (Deps.GRIST_FORCE_ENABLE_ENTERPRISE !== undefined) {
    const enabledByEnv = isAffirmative(Deps.GRIST_FORCE_ENABLE_ENTERPRISE);
    if (enabledByEnv !== Deps.GRIST_CONFIG_IS_ENTERPRISE) {
      throw new Error('Inconsistent Enterprise activation: the config.json file ' +
        'and the GRIST_FORCE_ENABLE_ENTERPRISE environment variable do not match.');
    }
    return enabledByEnv;
  }
  return Deps.GRIST_CONFIG_IS_ENTERPRISE;
};

/**
 * Plan: when grist-ee is installed, it will show a trial period
 * banner until an activation key is supplied. We plan to offer
 * free and paid keys; in either case, we want to know about the
 * existence of the user.
 *
 * Ideally, in a fully fleshed out flow from our marketing site
 * to a new deployment, a key could be carried along so there's
 * no need to show the trial nudge. But that won't be ready soon
 * and could be difficult to do in general.
 */
const TRIAL_PERIOD = 30;

/**
 * A public key for checking signatures.
 */
export const KEYS = [`-----BEGIN RSA PUBLIC KEY-----
MIICCgKCAgEA8xPmlfziJHfm/sH1C802n/d3rdzqwoTn71N7hqCc3LAMZgL5hGfj
Gc0NbrKn+txtMT5SRNRXvGQRmPc3U0Y0d3Y6I9ZhxKuXOAm88/za3CTC/yy7OvI5
AMWIY+JRIJ6sFo8Dxysl9iMDWHREiZ0Um3k7Q3+OTdE1ad2K+bGx1CsWZ9q/OjyJ
fJvMDO5k3TwG4ULdWplX2mcGKPqhMFJmhoUEq4gByK3k9yGs0+YUkyKu4TE5DN6N
87dBRNA1uqM5G5zRJu1IRWwu2n6PSy0ghlis1Ww/uImw0NPwmiD9A/5Y+0jwLPQO
bG2YqPnVJ+C0GSK/W4P7kZ6hQzYOmI/3su9FrfWZcdZwkFzuI48aKTC29GV5Spcy
iJtuTBRlifzb2RSQBL1kOZ5hqXUf7FxMY8EkSEsE8f/4Q0T2518Ie6smzIXVfaV+
hM1yS8aZFO+Sxjb7XtWqCbDYi40lfi0AUQdWDLC/I5RUm9Zf6KhQvi/EZfpph9df
hNugZIPepI6aKCOpoEXSzm0M2TmKRibQ8HFH5SYYDdK2WNn3ZlMGzZ6g+nk73c2v
l1UcZN7uyl/7xMnwMoAHF+g0BRAta/vwwVtz4JFTB+yIbVa/MiUEp8ZfwMU1mUE8
gmElH8zP/+iCdGeg5l5WS0Ig1/NEEuc0AH5VZr1q8py/kmO1udlZtbsCAwEAAQ==
-----END RSA PUBLIC KEY-----
`];

/**
 * The expected content of activation keys, once decoded.
 */
export interface ActivationContent {
  secret: string;      // Something to quote in talking to billing service.
  start?: string;      // ISO8601 date at which activation subscription started.
  end?: string;        // ISO8601 date at which activation no longer applies.
  // NOTE: the activation key is a jwt token, which can be set to expire.
  // We do not equate the end date of the key with the expiration date
  // of the token, since it is useful to be able to interrogate a key that
  // has gone past its end date.
  domains?: string[];  // optionally limit domains that can be served.
  // (not yet implemented)
  installationId?: string;// optionally limit activation to a particular installation.
  planName?: string;      // optionally name of the plan.
  features?: Features;    // optionally limit features that can be used.
}

/**
 * A class to handle reading activation keys and reporting on
 * activation status.
 */
export class ActivationReader {
  public installationId: string;
  public memberCount: number = 0;
  public activationStatus: ActivationState | null = null;

  private _activationRow: Activation;
  private _keyContent: ActivationContent | null = null;

  constructor(private _dal: ActivationsManager, private _keys: string[]) {
  }

  /**
   * If an activation key is present in environment or file,
   * use it and save it in the database. Then check the current
   * state of the activation.
   *
   * If force is true, reinitialize even if the update date is the same.
   */
  public async check() {
    return await this._dal.runInTransaction(async (manager) => {
      // Read the row from database, if it doesn't exist, create it.
      const activation = await this._dal.current(manager);

      // Store it for later.
      this._activationRow = activation;

      // Expose some fields.
      this.installationId = activation.id;

      // If enterprise is not enabled, enable it - and start trial period.
      if (activation.enabledAt === null) {
        // Set the first time this Enterprise code is enabled
        activation.enabledAt = new Date();
        await manager.save(activation);
      }

      // Read the key from environment or file and replace it. It also means that
      // the key uploaded via UI will be replaced by the one in the file.
      const text = this._readActivationText();
      if (text && text !== activation.key) {
        activation.key = text;
        await manager.save(activation);
      }

      // Parse the key to get the content.
      const content = activation.key ? this.readActivation(activation.key) : null;

      this._keyContent = content;

      // Reread the member count.
      this.memberCount = await this._dal.memberCount(manager);

      // Calculate the current state.
      this.activationStatus = this._calculate();

      // If the limits exceeded date is different update it.
      await this._updateGraceDate(this.activationStatus, manager);

      activation.updatedAt = new Date();
      await manager.save(activation);

      return true;
    });
  }

  public async readLatest() {
    return await this._dal.runInTransaction(async (manager) => {
      const activation = await this._dal.current(manager);
      // Store it for later.
      this._activationRow = activation;

      this.memberCount = await this._dal.memberCount(manager);

      this.installationId = activation.id;
      this._keyContent = activation.key ? this.readActivation(activation.key) : null;

      this.activationStatus = this._calculate();
    });
  }

  /**
   * Exposed for the UI.
   */
  public keyHeader() {
    return this._activationRow.key?.slice(0, 4) ?? '';
  }

  /**
   * Utility to take a signed activation key (a jwt token, with optional
   * whitespace) and return a decoded ActivationContent.
   */
  public readActivation(signed: string): ActivationContent {
    // accept white space in the key.
    const code = signed.replace(/\s/g, '');
    let error: unknown;
    for (const key of this._keys) {
      let content: ActivationContent;
      try {
        content = jwt.verify(code, key, {algorithms: ['RS256']}) as ActivationContent;
      } catch (e) {
        error = e;
        continue;
      }
      if (!content.secret) {
        throw new Error('Activation key is verified but missing expected fields');
      }
      return content;
    }
    if (error) {
      throw new Error('Could not verify activation key', {cause: error as Error});
    }
    throw new Error('Could not verify activation key');
  }

  /**
   * Check the current activation state, based on a saved activation
   * key (if available) and current limit.
   */
  private async _updateGraceDate(status: ActivationState, transaction?: EntityManager) {
    const storedText = this._activationRow.gracePeriodStart?.toISOString() ?? null;
    const newGraceStartText = status.grace?.graceStarted ?? null;
    let gracePeriodStart = newGraceStartText ? new Date(newGraceStartText) : null;
    if (newGraceStartText !== storedText) {
      const now = moment();
      // If we are setting grace period, make sure it is in the past.
      if (gracePeriodStart && moment(gracePeriodStart).isAfter(now)) {
        gracePeriodStart = now.toDate();
      }
      await this._dal.updateGracePeriod(gracePeriodStart, transaction);
      this._activationRow.gracePeriodStart = gracePeriodStart;
    }
  }

  /**
   * Check the current activation state, based on a saved activation
   * key (if available) and current limit.
   */
  private _calculate(): ActivationState {
    const now = new Date();
    // Read the key from db.
    const keyContent = this._keyContent;

    // If we have key.
    if (keyContent) {

      // Make sure that if the key has installation id it matches the current installation.
      if (keyContent.installationId && keyContent.installationId !== this.installationId) {
        log.warn('Activation key is for a different installation', {
          installationId: this.installationId,
          keyInstallationId: keyContent.installationId,
        });
        return {
          installationId: this.installationId,
          needKey: true,
          error: 'Your activation key is for a different installation.'
        };
      }

      // Get its expiration date.
      const expirationDate = this._keyContent?.end;
      // Figure out how many days are left.
      const daysLeft = expirationDate ? Math.max(0, daysTill(now, expirationDate)) : undefined;

      // Read limits from key and db.
      const features = keyContent.features || {};
      const result: ActivationState = {
        installationId: this.installationId,
        key: {
          expirationDate,
          daysLeft,
        },
        features,
      };

      // Figure out if key still applies.
      const exceededSeats = features.installationSeats !== undefined && this.memberCount > features.installationSeats;
      const expired = expirationDate !== undefined && isAfter(now, expirationDate);
      const violated = exceededSeats || expired;

      // Currently we only know how to control seats.
      if (features.installationSeats !== undefined) {
        result.current = {
          installationSeats: this.memberCount,
        };
      }

      // If terms are violated, we need to start grace period.
      if (violated && result.key) {
        // If grace period is enabled.
        if (features.installationGracePeriodDays !== undefined) {
          // Read the date it started, make sure it hasn't started in the future.
          const graceStart = DateX.min(
            // Saved date.
            this._activationRow.gracePeriodStart ?? now,
            // Expiration date.
            expirationDate ? new Date(expirationDate) : now,
            // Now
            now,
          );
          // Figure out when it should end.
          const graceEnd = endDate(graceStart, features.installationGracePeriodDays);
          // Figure out how many days are left.
          const daysLeftGrace = Math.max(0, daysTill(now, graceEnd));
          result.grace = {
            daysLeft: daysLeftGrace,
            graceStarted: graceStart.toISOString(),
          };
          result.needKey = daysLeftGrace <= 0;
        } else {
          result.needKey = true;
        }
      }

      return result;
    } else {
      const trialStart = this._activationRow.enabledAt;
      if (trialStart) {
        const expirationDate = moment(trialStart).add(TRIAL_PERIOD, 'days').format();
        const daysLeft = Math.max(0, daysTill(now, expirationDate));
        const result: ActivationState = {
          installationId: this.installationId,
          trial: {
            days: TRIAL_PERIOD,
            daysLeft,
            expirationDate,
          },
          needKey: daysLeft <= 0,
        };
        return result;
      } else {
        return {
          installationId: this.installationId,
          needKey: true
        };
      }
    }
  }

  /**
   * Look for activation key in environment variable `GRIST_ACTIVATION`
   * or in a file specified by environment variable `GRIST_ACTIVATION_FILE`.
   */
  private _readActivationText(): string | null {
    if (Deps.GRIST_ACTIVATION) {
      return Deps.GRIST_ACTIVATION;
    }
    if (Deps.GRIST_ACTIVATION_FILE) {
      return fs.readFileSync(Deps.GRIST_ACTIVATION_FILE, 'utf8');
    }
    return null;
  }
}

/** Number of days till the end date, rounded up, not less than 0 */
function daysTill(from: MomentInput, to: MomentInput): number {
  const hours = moment(to).diff(moment(from), 'hours');
  if (hours <= 0) {
    return 0;
  }
  const days = Math.ceil(hours / 24);
  return days;
}

function isAfter(from: MomentInput, to: MomentInput): boolean {
  return moment(from).isAfter(moment(to));
}

function endDate(start: MomentInput, days: number): Date {
  return moment(start).add(days, 'days').toDate();
}

const DateX = {
  max(date: Date, ...dates: Date[]): Date {
    return dates.filter(Boolean).reduce((max, d) => d > max ? d : max, date);
  },
  min(date: Date, ...dates: Date[]): Date {
    return dates.filter(Boolean).reduce((min, d) => d < min ? d : min, date);
  }
};
