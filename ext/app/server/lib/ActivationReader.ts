import { ActivationState } from 'app/common/gristUrls';
import { Activation } from 'app/gen-server/entity/Activation';
import { Activations } from 'app/gen-server/lib/Activations';
import { RequestWithLogin } from 'app/server/lib/Authorizer';
import { HomeDBManager } from 'app/gen-server/lib/HomeDBManager';
import { expressWrap } from 'app/server/lib/expressWrap';
import * as express from 'express';
import * as fs from 'fs';
import * as jwt from 'jsonwebtoken';
import moment from 'moment';

const GRIST_ACTIVATION = process.env.GRIST_ACTIVATION;
const GRIST_ACTIVATION_FILE = process.env.GRIST_ACTIVATION_FILE;
const TEST_ENABLE_ACTIVATION = process.env.TEST_ENABLE_ACTIVATION;

export const Deps = {GRIST_ACTIVATION, GRIST_ACTIVATION_FILE,
                     TEST_ENABLE_ACTIVATION};

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
const keys = [`-----BEGIN RSA PUBLIC KEY-----
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
  secret: string;  // Something to quote in talking to billing service.
  start?: string;  // ISO8601 date at which activation was minted.
  end?: string;    // ISO8601 date at which activation no longer applies.
  // NOTE: the activation key is a jwt token, which can be set to expire.
  // We do not equate the end date of the key with the expiration date
  // of the token, since it is useful to be able to interrogate a key that
  // has gone past its end date.
  domains?: string[];  // optionally limit domains that can be served.
                       // (not yet implemented)
  installationId?: string;  // optionally limit activation to a particular installation.
                            // (not yet implemented)
}

/**
 * A class to handle reading activation keys and reporting on
 * activation status.
 */
export class ActivationReader {
  private _activation: Activation;
  private _content: ActivationContent|null = null;

  constructor(private _db: HomeDBManager) {
  }

  /**
   * If an activation key is present in environment or file,
   * use it and save it in the database.
   */
  public async initialize() {
    const activations = new Activations(this._db);
    const activation = await activations.current();
    const text = this._readActivationText();
    if (text && text !== activation.key) {
      activation.key = text;
      await activation.save();
    }
    const content = activation.key ? readActivation(activation.key) : null;
    this._activation = activation;
    this._content = content;
  }

  /**
   * Check the current activation state, based on a saved activation
   * key (if available).
   */
  public check(): ActivationState {
    const state: ActivationState = {};
    const now = moment();
    if (this._content) {
      if (this._content.end) {
        const end = moment(this._content.end);
        const remaining = end.diff(now, 'days');
        if (remaining >= 0) {
          state.key = {
            expirationDate: this._content.end,
            daysLeft: remaining,
          };
        }
      } else {
        // This key has no time limit.
        state.key = {};
      }
    }
    if (!state.key) {
      const trialStart = moment(this._activation.createdAt);
      const daysSinceTrialStart = now.diff(moment(this._activation.createdAt), 'days');
      if (daysSinceTrialStart < TRIAL_PERIOD) {
        state.trial = {
          days: TRIAL_PERIOD,
          expirationDate: trialStart.add(TRIAL_PERIOD, 'days').format(),
          daysLeft: TRIAL_PERIOD - daysSinceTrialStart,
        };
      }
    }
    if (!state.key && !state.trial) {
      state.needKey = true;
    }
    return state;
  }

  /**
   * Look for activation key in environment variable `GRIST_ACTIVATION`
   * or in a file specified by environment variable `GRIST_ACTIVATION_FILE`.
   */
  private _readActivationText(): string|null {
    if (Deps.GRIST_ACTIVATION) { return Deps.GRIST_ACTIVATION; }
    if (Deps.GRIST_ACTIVATION_FILE) {
      return fs.readFileSync(Deps.GRIST_ACTIVATION_FILE, 'utf8');
    }
    return null;
  }
}

/**
 * Utility to take a signed activation key (a jwt token, with optional
 * whitespace) and return a decoded ActivationContent.
 */
export function readActivation(signed: string): ActivationContent {
  // accept white space in the key.
  const code = signed.replace(/\s/g, '');
  let error: unknown;
  for (const key of keys) {
    let content: ActivationContent;
    try {
      content = jwt.verify(code, key, {algorithms: ['RS256']}) as ActivationContent;
    } catch (e) {
      error = e;
      continue;
    }
    if (!content.secret) {
      throw new Error('activation key is verified but missing expected fields');
    }
    return content;
  }
  if (error) { throw error; }
  throw new Error('could not verify activation key');
}

/**
 * Add express middleware to insert an "activation" field with the current
 * state of activation.
 */
export async function addActivationMiddleware(db: HomeDBManager, app: express.Express, options?: {
  skipActivationCheck: boolean
}) {
  const reader = new ActivationReader(db);
  await reader.initialize();
  app.use(expressWrap(async (req, res, next) => {
    if (options?.skipActivationCheck && !Deps.TEST_ENABLE_ACTIVATION) {
      return next();
    }
    const mreq = req as RequestWithLogin;
    const activationState = reader.check();
    mreq.activation = activationState;
    db.setRestrictedMode(Boolean(activationState.needKey));
    next();
  }));
}
