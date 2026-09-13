import { asNullableRecord as asConfigRecord } from "@openclaw/normalization-core/record-coerce";
import { html, type TemplateResult } from "lit";
import "../../components/mcp-servers-card.ts";
import {
  renderLearnMoreLink,
  renderSettingsDefaultDescription,
  renderSettingsRow,
  renderSettingsSection,
  renderSettingsToggleRow,
  renderSettingsValue,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { summarizeMcpServers } from "../../lib/config/mcp-servers.ts";

const MCP_DOCS_URL = "https://docs.openclaw.ai/tools/mcp";
const MCP_APPS_DOCS_URL = "https://docs.openclaw.ai/cli/mcp/apps";

type McpViewProps = {
  configObject: Record<string, unknown>;
  pluginsHref: string;
  configBusy: boolean;
  onAppsEnabledToggle?: (enabled: boolean) => void;
  /** Embedded schema editor; it owns autosave status and the restart banner. */
  editor: TemplateResult;
};

export function renderMcp(props: McpViewProps) {
  const rows = summarizeMcpServers(props.configObject) ?? [];
  const enabledCount = rows.filter((row) => row.enabled).length;
  const oauthCount = rows.filter((row) => row.auth === "oauth").length;
  const filteredCount = rows.filter((row) => row.toolFilter).length;
  const mcpConfig = asConfigRecord(props.configObject.mcp);
  const appsConfig = asConfigRecord(mcpConfig?.apps);
  const appsEnabled = appsConfig?.enabled === true;
  const appsEnabledOverridden = appsConfig !== null && Object.hasOwn(appsConfig, "enabled");
  return html`
    <section class="mcp-page">
      <div class="settings-page">
        <section class="settings-section mcp-page__summary">
          <div class="settings-section__header">
            <h2 class="settings-section__heading">${t("mcpPage.servers")}</h2>
          </div>
          <div class="settings-group">
            ${renderSettingsRow({
              title: t("mcpPage.servers"),
              control: renderSettingsValue(rows.length),
            })}
            ${renderSettingsRow({
              title: t("common.enabled"),
              control: renderSettingsValue(enabledCount),
            })}
            ${renderSettingsRow({
              title: t("mcpPage.oauth"),
              control: renderSettingsValue(oauthCount),
            })}
            ${renderSettingsRow({
              title: t("mcpPage.filtered"),
              control: renderSettingsValue(filteredCount),
            })}
          </div>
        </section>

        ${renderSettingsSection({ title: t("mcpPage.apps.title") }, [
          renderSettingsToggleRow({
            title: t("mcpPage.apps.title"),
            description: html`
              ${t("mcpPage.apps.description")} ${renderLearnMoreLink(MCP_APPS_DOCS_URL)}
              <span>${t("mcpPage.apps.restartRequired")}</span>
              <span
                >${renderSettingsDefaultDescription(
                  t("common.disabled"),
                  appsEnabledOverridden,
                )}</span
              >
            `,
            checked: appsEnabled,
            disabled: props.configBusy,
            onChange: (enabled) => props.onAppsEnabledToggle?.(enabled),
          }),
        ])}

        <section class="settings-section">
          <div class="settings-section__header">
            <h2 class="settings-section__heading">${t("mcpPage.operatorCommands")}</h2>
          </div>
          <p class="settings-section__desc">${t("mcpPage.operatorCommandsHint")}</p>
          <div class="settings-group">
            <div class="settings-row settings-row--stacked">
              <div class="mcp-command-card__grid">
                <code>openclaw mcp status --verbose</code>
                <code>openclaw mcp doctor --probe</code>
                <code>openclaw mcp login &lt;name&gt;</code>
                <code>openclaw mcp reload</code>
              </div>
            </div>
          </div>
        </section>

        <openclaw-mcp-servers-card
          .pluginsHref=${props.pluginsHref}
          .docsUrl=${MCP_DOCS_URL}
        ></openclaw-mcp-servers-card>
      </div>

      ${props.editor}
    </section>
  `;
}
