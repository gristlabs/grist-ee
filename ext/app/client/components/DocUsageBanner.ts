import {Banner, buildBannerMessage} from 'app/client/components/Banner';
import {buildLimitStatusMessage, buildUpgradeMessage} from 'app/client/components/DocumentUsage';
import {sessionStorageBoolObs} from 'app/client/lib/localStorageObs';
import {DocPageModel} from 'app/client/models/DocPageModel';
import {isFreePlan} from 'app/common/Features';
import {canUpgradeOrg} from 'app/common/roles';
import {Computed, Disposable, dom, DomComputed, makeTestId, Observable} from 'grainjs';

const testId = makeTestId('test-doc-usage-banner-');

export class DocUsageBanner extends Disposable {
  private readonly _currentDocId = this._docPageModel.currentDocId;
  private readonly _currentDocUsage = this._docPageModel.currentDocUsage;
  private readonly _currentOrg = this._docPageModel.currentOrg;

  private readonly _dataLimitStatus = Computed.create(this, this._currentDocUsage, (_use, usage) => {
    return usage?.dataLimitStatus ?? null;
  });

  private readonly _shouldShowBanner: Computed<boolean> =
    Computed.create(this, this._currentOrg, (_use, org) => {
      return org?.access !== 'guests' && org?.access !== null;
    });

  // Session storage observable. Set to false to dismiss the banner for the session.
  private _showApproachingLimitBannerPref: Observable<boolean>;

  constructor(private _docPageModel: DocPageModel) {
    super();
    this.autoDispose(this._currentDocId.addListener((docId) => {
      if (this._showApproachingLimitBannerPref?.isDisposed() === false) {
        this._showApproachingLimitBannerPref.dispose();
      }
      const userId = this._docPageModel.appModel.currentUser?.id ?? 0;
      this._showApproachingLimitBannerPref = sessionStorageBoolObs(
        `u=${userId}:doc=${docId}:showApproachingLimitBanner`,
        true,
      );
    }));
  }

  public buildDom() {
    return dom.maybe(this._dataLimitStatus, (status): DomComputed => {
      switch (status) {
        case 'approachingLimit': { return this._buildApproachingLimitBanner(); }
        case 'gracePeriod':
        case 'deleteOnly': { return this._buildExceedingLimitBanner(status); }
      }
    });
  }

  private _buildApproachingLimitBanner() {
    return dom.maybe(this._shouldShowBanner, () => {
      return dom.domComputed(use => {
        if (!use(this._showApproachingLimitBannerPref)) {
          return null;
        }

        const org = use(this._currentOrg);
        if (!org) { return null; }

        const product = org.billingAccount?.product;
        return dom.create(Banner, {
          content: buildBannerMessage(
            buildLimitStatusMessage('approachingLimit', product?.features),
            (product && isFreePlan(product.name)
              ? [' ', buildUpgradeMessage(
                canUpgradeOrg(org),
                'long',
                () => this._docPageModel.appModel.showUpgradeModal()
              )]
              : null
            ),
            testId('text')
          ),
          style: 'warning',
          showCloseButton: true,
          onClose: () => this._showApproachingLimitBannerPref.set(false),
        });
      });
    });
  }

  private _buildExceedingLimitBanner(status: 'gracePeriod' | 'deleteOnly') {
    return dom.maybe(this._shouldShowBanner, () => {
      return dom.maybe(this._currentOrg, org => {
        const canUpgrade = canUpgradeOrg(org);
        const product = org.billingAccount?.product;
        return dom.create(Banner, {
          content: buildBannerMessage(
            buildLimitStatusMessage(status, product?.features),
            (product && isFreePlan(product.name)
              ? [' ', buildUpgradeMessage(
                canUpgrade,
                'long',
                () => this._docPageModel.appModel.showUpgradeModal()
              )]
              : null
            ),
            testId('text'),
          ),
          contentSmall: buildBannerMessage(
            (product && isFreePlan(product.name)
              ? buildUpgradeMessage(
                canUpgrade,
                'short',
                () => this._docPageModel.appModel.showUpgradeModal()
              )
              : buildLimitStatusMessage(status, product?.features)
            ),
            testId('text'),
          ),
          style: 'error',
          showCloseButton: false,
          showExpandButton: true,
        });
      });
    });
  }
}
