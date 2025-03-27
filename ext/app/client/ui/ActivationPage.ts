import {buildHomeBanners} from 'app/client/components/Banners';
import {AppModel} from 'app/client/models/AppModel';
import {ActivationModel, ActivationModelImpl} from 'app/client/models/ActivationModel';
import {urlState} from 'app/client/models/gristUrlState';
import * as css from 'app/client/ui/ActivationPageCss';
import {AppHeader} from 'app/client/ui/AppHeader';
import {DefaultActivationPage, IActivationPageCreator} from 'app/client/ui/DefaultActivationPage';
import {createForbiddenPage} from 'app/client/ui/errorPages';
import {leftPanelBasic} from 'app/client/ui/LeftPanelCommon';
import {pagePanels} from 'app/client/ui/PagePanels';
import {createTopBarHome} from 'app/client/ui/TopBar';
import {cssBreadcrumbs, separator} from 'app/client/ui2018/breadcrumbs';
import {bigPrimaryButtonLink} from 'app/client/ui2018/buttons';
import {cssLink} from 'app/client/ui2018/links';
import {loadingSpinner} from 'app/client/ui2018/loaders';
import {ActivationStatus} from 'app/common/ActivationAPI';
import { commonUrls, getPageTitleSuffix } from 'app/common/gristUrls';
import {getGristConfig} from 'app/common/urlUtils';
import {Computed, Disposable, dom, makeTestId, Observable, subscribe} from 'grainjs';
import {isEnterpriseDeployment} from "app/client/lib/enterpriseDeploymentCheck";
import {markdown} from 'app/client/lib/markdown';

const testId = makeTestId('test-ap-');

export function getActivationPage(): IActivationPageCreator {
  return isEnterpriseDeployment() ? EnterpriseActivationPage : DefaultActivationPage;
}

export function showEnterpriseToggle() {
  // We show this toggle for both Enterprise and Core deployments.
  // The core build (oss image) in stubs returns false here.
  return true;
}

class EnterpriseActivationPage extends Disposable {
  private readonly _currentPage = Computed.create(this, urlState().state, (_use, s) => s.activation);
  private _model: ActivationModel = new ActivationModelImpl(this._appModel);

  constructor(private _appModel: AppModel) {
    super();
    this._setPageTitle();
    this._model.fetchActivationStatus(true).catch(reportError);
  }

  public buildDom() {
    return dom.domComputed(this._model.isUnauthorized, (isUnauthorized) => {
      if (isUnauthorized) {
        return createForbiddenPage(this._appModel, 'Access denied.');
      } else {
        const panelOpen = Observable.create(this, false);
        return pagePanels({
          leftPanel: {
            panelWidth: Observable.create(this, 240),
            panelOpen,
            hideOpener: true,
            header: dom.create(AppHeader, this._appModel),
            content: leftPanelBasic(this._appModel, panelOpen),
          },
          headerMain: this._buildMainHeader(),
          contentTop: buildHomeBanners(this._appModel),
          contentMain: this._buildMainContent(),
        });
      }
    });
  }

  private _buildMainHeader() {
    return dom.frag(
      cssBreadcrumbs({ style: 'margin-left: 16px;' },
        cssLink(
          urlState().setLinkUrl({}),
          'Home',
          testId('home'),
        ),
        separator(' / '),
        dom('span', 'Activation'),
      ),
      createTopBarHome(this._appModel),
    );
  }

  private _buildMainContent() {
    return css.activationPageContainer(
      css.activationPage(
        dom('div',
          css.siteInfoHeader('Site Info'),
          this._buildActivationSummary(),
        ),
      ),
    );
  }

  private _buildActivationSummary() {
    return dom.domComputed(this._model.activationStatus, status => {
      if (!status) {
        return css.spinnerBox(
          loadingSpinner(),
          testId('loading'),
        );
      }

      return [
        css.summaryRow(
          testId('summary'),
          css.summaryRowHeader('Status'),
          css.planStatusContainer(getPlanStatusDom(status)),
        ),
        status.features?.installationSeats ? [
          css.summaryRow(
            testId('seats'),
            css.summaryRowHeader('Members'),
            css.planStatusContainer(getSeatsDom(status)),
          ),
        ] : null,
        css.summaryButtons(
          bigPrimaryButtonLink('Contact Us', {
            href: commonUrls.contact,
            target: '_blank',
          }),
        ),
      ];
    });
  }

  private _setPageTitle() {
    this.autoDispose(subscribe(this._currentPage, (_use, page): string => {
      const suffix = getPageTitleSuffix(getGristConfig());
      switch (page) {
        case undefined:
        case 'activation': {
          return document.title = `Activation${suffix}`;
        }
      }
    }));
  }
}

function getPlanStatusDom(status: ActivationStatus) {
  // TODO: 'Enterprise Plan' is a short-term placeholder; at some point we should
  // pull the plan name/details from the `status` (or some other source).
  const planName = css.planName(status.trial ? 'Trial' : 'Enterprise Plan');
  const inGoodStanding = !status.needKey;
  const isInTrial = Boolean(status.trial && status.trial.daysLeft > 0 && !status.key);
  const expirationDate = status.key?.expirationDate ?? status.trial?.expirationDate;
  const exceeded = status.key?.daysLeft && status.key?.daysLeft > 0 && !inGoodStanding;

  let content: HTMLElement[];
  if (!inGoodStanding) {
    content = [
      css.planStatusText(planName, exceeded ? ' exceeded' : ' ended'),
      css.planStatusIcon('CrossSmall', css.planStatusIcon.cls('-invalid')),
    ];
  } else if (isInTrial) {
    content = [
      css.planStatusText(planName, ' until ', css.expirationDate(getFormattedDate(expirationDate)))
    ];
  } else {
    content = [
      expirationDate
        ? css.planStatusText(planName, ' active until ', css.expirationDate(getFormattedDate(expirationDate)))
        : css.planStatusText(planName, ' active'),
      css.planStatusIcon('Tick', css.planStatusIcon.cls('-valid')),
    ];
  }

  return css.planStatus(...content, testId('status-text'));
}



function getSeatsDom(status: ActivationStatus) {
  const max = status.features?.installationSeats;
  if (max === undefined) { return null; }
  const current = status.current?.installationSeats || 0;
  const valid = current <= max;

  const content = [
    // Write down how many user we have currently and how many we can have
    css.planStatusText(css.cssLine(
      markdown(`**${current}** of **${max}** seats used`),
      testId('seats-text'),
    )),
    css.planStatusIcon(valid ? 'Tick' : 'CrossSmall', css.planStatusIcon.cls(valid ? '-valid' : '-invalid')),
  ];

  return css.planStatus(...content);
}

function getFormattedDate(date: string | null | undefined): string | null {
  if (!date) { return null; }

  return new Date(date).toLocaleDateString('default', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}
