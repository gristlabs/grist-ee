import {mediaSmall, theme, vars} from 'app/client/ui2018/cssVars';
import {icon} from 'app/client/ui2018/icons';
import {styled} from 'grainjs';

export const activationPageContainer = styled('div', `
  display: flex;
  justify-content: center;
  overflow-y: auto;
`);

export const activationPage = styled('div', `
  padding: 16px;
  max-width: 600px;
  width: 100%;
`);

export const siteInfoHeader = styled('div', `
  height: 32px;
  line-height: 32px;
  margin-bottom: 24px;
  color: ${theme.text};
  font-size: ${vars.xxxlargeFontSize};
  font-weight: ${vars.headerControlTextWeight};
`);

export const summaryRowHeader = styled('div', `
  min-width: 110px;
  padding: 8px 0;
  display: inline-block;
  vertical-align: top;
  font-weight: bold;
  color: ${theme.text};
`);

export const summaryRow = styled('div', `
  margin: 8px 0px;
  display: flex;
  align-items: center;

  @media ${mediaSmall} {
    & {
      flex-direction: column;
      align-items: flex-start;
    }
  }
`);

export const summaryButtons = styled('div', `
  margin-top: 24px;
  margin-left: 110px;

  @media ${mediaSmall} {
    & {
      margin-left: 0px;
    }
  }
`);

export const planStatusContainer = styled('div', `
  display: flex;
  align-items: center;
  flex-grow: 1;
  min-width: 0;
  border: 1px solid ${theme.inputReadonlyBorder};
  border-radius: ${vars.controlBorderRadius};
  background-color: ${theme.inputReadonlyBg};

  @media ${mediaSmall} {
    & {
      width: 100%;
    }
  }
`);

export const planStatus = styled('div', `
  display: flex;
  align-items: center;
`);

export const planStatusText = styled('div', `
  padding: 8px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`);

export const planStatusIcon = styled(icon, `
  width: 24px;
  height: 24px;

  &-valid {
    --icon-color: ${theme.inputValid};
  }
  &-invalid {
    --icon-color: ${theme.inputInvalid};
  }
`);

export const planName = styled('span', `
  font-weight: bold;
`);

export const expirationDate = styled('span', `
  font-weight: bold;
`);

export const spinnerBox = styled('div', `
  text-align: center;
`);
