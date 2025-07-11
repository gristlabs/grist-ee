import {Banner, buildBannerMessage} from 'app/client/components/Banner';
import {buildUpgradeMessage} from 'app/client/components/DocumentUsage';
import {sessionStorageBoolObs} from 'app/client/lib/localStorageObs';
import {AppModel} from 'app/client/models/AppModel';
import {OrgUsageSummary} from 'app/common/DocUsage';
import {isFreePlan} from 'app/common/Features';
import {isOwner} from 'app/common/roles';
import {Disposable, dom, makeTestId, Observable} from 'grainjs';

const testId = makeTestId('test-site-usage-banner-');

export class SiteUsageBanner extends Disposable {
  private readonly _currentOrg = this._app.currentOrg;
  private readonly _currentOrgUsage = this._app.currentOrgUsage;
  private readonly _product = this._currentOrg?.billingAccount?.product;
  private readonly _currentUser = this._app.currentValidUser;

  // Session storage observable. Set to false to dismiss the banner for the session.
  private _showApproachingLimitBannerPref?: Observable<boolean>;

  constructor(private _app: AppModel) {
    super();

    if (this._currentUser && isOwner(this._currentOrg)) {
      this._showApproachingLimitBannerPref = this.autoDispose(sessionStorageBoolObs(
        `u=${this._currentUser.id}:org=${this._currentOrg.id}:showApproachingLimitBanner`,
        true,
      ));
    }
  }

  public buildDom() {
    return dom.maybe(this._currentOrgUsage, (usage) => {
      const {approachingLimit, gracePeriod, deleteOnly} = usage.countsByDataLimitStatus;
      if (deleteOnly > 0 || gracePeriod > 0 || usage.attachments.limitExceeded) {
        return this._buildExceedingLimitsBanner(usage);
      } else if (approachingLimit > 0) {
        return this._buildApproachingLimitsBanner(approachingLimit);
      } else {
        return null;
      }
    });
  }

  private _buildApproachingLimitsBanner(numDocs: number) {
    return dom.domComputed(use => {
      if (this._showApproachingLimitBannerPref && !use(this._showApproachingLimitBannerPref)) {
        return null;
      }

      const limitsMessage = numDocs > 1
        ? `${numDocs} documents are approaching their limits.`
        : `${numDocs} document is approaching its limits.`;
      return dom.create(Banner, {
        content: buildBannerMessage(
          limitsMessage,
          (this._product && isFreePlan(this._product.name)
            ? [' ', buildUpgradeMessage(true, 'long', () => this._app.showUpgradeModal())]
            : null
          ),
          testId('text'),
        ),
        style: 'warning',
        showCloseButton: true,
        onClose: () => this._showApproachingLimitBannerPref?.set(false),
      });
    });
  }

  private _buildExceedingLimitsBanner(usage: OrgUsageSummary) {
    const numDocs = usage.countsByDataLimitStatus.gracePeriod +
        usage.countsByDataLimitStatus.deleteOnly;
    const docLimitsMessage = numDocs > 1
      ? `${numDocs} documents have exceeded their limits.`
      : `${numDocs} document has exceeded its limits.`;
    const limitsMessage = usage.attachments.limitExceeded
        ? (numDocs === 0
            ? `Site attachment limit exceeded.`
            : `Multiple limits exceeded.`)
        : docLimitsMessage;
    return dom.create(Banner, {
      content: buildBannerMessage(
        limitsMessage,
        (this._product && isFreePlan(this._product.name)
          ? [' ', buildUpgradeMessage(true, 'long', () => this._app.showUpgradeModal())]
          : null
        ),
        testId('text'),
      ),
      contentSmall: buildBannerMessage(
        (this._product && isFreePlan(this._product.name)
          ? buildUpgradeMessage(true, 'short', () => this._app.showUpgradeModal())
          : limitsMessage
        ),
      ),
      style: 'error',
      showCloseButton: false,
      showExpandButton: true,
    });
  }
}
