import {buildHomeBanners} from 'app/client/components/Banners';
import {AppModel} from 'app/client/models/AppModel';
import {ActivationModel, ActivationModelImpl} from 'app/client/models/ActivationModel';
import {urlState} from 'app/client/models/gristUrlState';
import * as css from 'app/client/ui/ActivationPageCss';
import {AppHeader} from 'app/client/ui/AppHeader';
import {createForbiddenPage} from 'app/client/ui/errorPages';
import {leftPanelBasic} from 'app/client/ui/LeftPanelCommon';
import {pagePanels} from 'app/client/ui/PagePanels';
import {createTopBarHome} from 'app/client/ui/TopBar';
import {cssBreadcrumbs, cssBreadcrumbsLink, separator} from 'app/client/ui2018/breadcrumbs';
import {bigPrimaryButtonLink} from 'app/client/ui2018/buttons';
import {loadingSpinner} from 'app/client/ui2018/loaders';
import {IActivationStatus} from 'app/common/ActivationAPI';
import {commonUrls} from 'app/common/gristUrls';
import {Disposable, dom, makeTestId, Observable} from 'grainjs';

const testId = makeTestId('test-ap-');

export class ActivationPage extends Disposable {
  private _model: ActivationModel = new ActivationModelImpl(this._appModel);

  constructor(private _appModel: AppModel) {
    super();
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
            header: dom.create(AppHeader, this._appModel.currentOrgName, this._appModel),
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
        cssBreadcrumbsLink(
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
        return css.spinnerBox(loadingSpinner());
      }

      return [
        css.summaryRow(
          css.summaryRowHeader('Status'),
          css.planStatusContainer(getPlanStatusDom(status)),
        ),
        css.summaryButtons(
          bigPrimaryButtonLink('Contact Us', {
            href: commonUrls.contact,
            target: '_blank',
          }),
        ),
      ];
    });
  }
}

function getPlanStatusDom(status: IActivationStatus) {
  // TODO: 'Enterprise Plan' is a short-term placeholder; at some point we should
  // pull the plan name/details from the `status` (or some other source).
  const planName = css.planName(status.isInTrial ? 'Trial' : 'Enterprise Plan');
  const {inGoodStanding, isInTrial} = status;
  const expirationDate = getFormattedDate(status.expirationDate);

  let content: HTMLElement[];
  if (!inGoodStanding) {
    content = [
      css.planStatusText(planName, ' ended'),
      css.planStatusIcon('CrossSmall', css.planStatusIcon.cls('-invalid')),
    ];
  } else if (isInTrial) {
    content = [
      css.planStatusText(planName, ' until ', css.expirationDate(expirationDate))
    ];
  } else {
    content = [
      css.planStatusText(planName, ' active until ', css.expirationDate(expirationDate)),
      css.planStatusIcon('Tick', css.planStatusIcon.cls('-valid')),
    ];
  }

  return css.planStatus(...content);
}

function getFormattedDate(date: string | null): string | null {
  if (!date) { return null; }

  return new Date(date).toLocaleDateString('default', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}
