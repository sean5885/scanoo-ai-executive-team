#!/usr/bin/env bash
set -euo pipefail

SKILLS=(
  "find-skills"
  "skill-creator"
  "obra/using-superpowers"
  "subagent-driven-development"
  "agent-tools"

  "copywriting"
  "systematic-debugging"
  "content-strategy"
  "marketing-ideas"
  "social-content"

  "web-design-guidelines"
  "frontend-ui-ux"
  "playwright"
  "code-yeongyu/dev-browser"
  "web-design-audit"
  "image-generator"

  "git-master"
  "code-review"
  "refactor"
  "testing-expert"
  "security-audit"
  "performance-optimization"

  "davila7/seo-optimizer"
  "growth-hacking"
  "data-analyst"
  "user-research"
  "competitor-analysis"

  "document-formatter"
  "davila7/xlsx"
  "openclaw/pptx-creator"
  "meeting-notes"
  "email-writer"
)

SUCCESS=()
FAILED=()

SAFE_DEFAULT=(
  "find-skills"
  "skill-creator"
  "obra/using-superpowers"
  "subagent-driven-development"
  "copywriting"
  "systematic-debugging"
  "content-strategy"
  "marketing-ideas"
  "social-content"
  "web-design-guidelines"
  "frontend-ui-ux"
  "web-design-audit"
  "code-review"
  "refactor"
  "testing-expert"
  "security-audit"
  "performance-optimization"
  "data-analyst"
  "user-research"
  "competitor-analysis"
  "document-formatter"
  "davila7/xlsx"
  "openclaw/pptx-creator"
  "meeting-notes"
  "git-master"
  "growth-hacking"
  "email-writer"
)

REVIEW_REQUIRED=(
  "davila7/seo-optimizer"
  "code-yeongyu/dev-browser"
  "playwright"
  "image-generator"
)

HIGH_RISK=(
  "agent-tools"
)

is_in_array() {
  local needle="$1"
  shift
  local item
  for item in "$@"; do
    if [ "$item" = "$needle" ]; then
      return 0
    fi
  done
  return 1
}

print_risk_summary() {
  local installed_safe=()
  local installed_review=()
  local installed_high=()
  local skill

  for skill in "${SUCCESS[@]}"; do
    if is_in_array "$skill" "${HIGH_RISK[@]}"; then
      installed_high+=("$skill")
    elif is_in_array "$skill" "${REVIEW_REQUIRED[@]}"; then
      installed_review+=("$skill")
    else
      installed_safe+=("$skill")
    fi
  done

  echo ""
  echo "======== 風險摘要 ========"
  echo "白名單（可作為一般預設）: ${#installed_safe[@]}"
  if [ ${#installed_safe[@]} -gt 0 ]; then
    for skill in "${installed_safe[@]}"; do
      echo "  - $skill"
    done
  fi

  echo ""
  echo "慎用（建議看情境再觸發）: ${#installed_review[@]}"
  if [ ${#installed_review[@]} -gt 0 ]; then
    for skill in "${installed_review[@]}"; do
      case "$skill" in
        "davila7/seo-optimizer") echo "  - $skill 〔大範圍內容優化，容易過度套用〕" ;;
        "code-yeongyu/dev-browser") echo "  - $skill 〔真實瀏覽器 / 已登入頁面操作〕" ;;
        "playwright") echo "  - $skill 〔可操作 cookies、storage、upload、browser code〕" ;;
        "image-generator") echo "  - $skill 〔外部影像 API，可能上傳參考圖〕" ;;
        *) echo "  - $skill" ;;
      esac
    done
  fi

  echo ""
  echo "高風險（建議明確批准後再用）: ${#installed_high[@]}"
  if [ ${#installed_high[@]} -gt 0 ]; then
    for skill in "${installed_high[@]}"; do
      case "$skill" in
        "agent-tools") echo "  - $skill 〔外部 CLI 安裝 + login + 可能上傳本地檔案〕" ;;
        *) echo "  - $skill" ;;
      esac
    done
  fi

  echo ""
  echo "詳細說明請看: /Users/seanhan/Documents/Playground/SKILLS_RISK_GUIDE.md"
}

resolve_skill_package() {
  case "$1" in
    "find-skills") echo "vercel-labs/skills@find-skills" ;;
    "skill-creator") echo "anthropics/skills@skill-creator" ;;
    "obra/using-superpowers") echo "obra/superpowers@using-superpowers" ;;
    "subagent-driven-development") echo "obra/superpowers@subagent-driven-development" ;;
    "agent-tools") echo "inferen-sh/skills@agent-tools" ;;
    "copywriting") echo "coreyhaines31/marketingskills@copywriting" ;;
    "systematic-debugging") echo "obra/superpowers@systematic-debugging" ;;
    "content-strategy") echo "coreyhaines31/marketingskills@content-strategy" ;;
    "marketing-ideas") echo "coreyhaines31/marketingskills@marketing-ideas" ;;
    "social-content") echo "coreyhaines31/marketingskills@social-content" ;;
    "web-design-guidelines") echo "vercel-labs/agent-skills@web-design-guidelines" ;;
    "frontend-ui-ux") echo "404kidwiz/claude-supercode-skills@frontend-ui-ux-engineer" ;;
    "playwright") echo "microsoft/playwright-cli@playwright-cli" ;;
    "code-yeongyu/dev-browser") echo "SawyerHood/dev-browser@dev-browser" ;;
    "web-design-audit") echo "addyosmani/web-quality-skills@web-quality-audit" ;;
    "image-generator") echo "lxfater/nano-image-generator-skill@nano-image-generator" ;;
    "git-master") echo "josiahsiegel/claude-plugin-marketplace@git-master" ;;
    "code-review") echo "supercent-io/skills-template@code-review" ;;
    "refactor") echo "github/awesome-copilot@refactor" ;;
    "testing-expert") echo "shipshitdev/library@testing-expert" ;;
    "security-audit") echo "sickn33/antigravity-awesome-skills@security-audit" ;;
    "performance-optimization") echo "supercent-io/skills-template@performance-optimization" ;;
    "davila7/seo-optimizer") echo "199-biotechnologies/claude-skill-seo-geo-optimizer@seo-geo-optimizer" ;;
    "growth-hacking") echo "vivy-yi/xiaohongshu-skills@growth-hacking" ;;
    "data-analyst") echo "shubhamsaboo/awesome-llm-apps@data-analyst" ;;
    "user-research") echo "anthropics/knowledge-work-plugins@user-research" ;;
    "competitor-analysis") echo "aaron-he-zhu/seo-geo-claude-skills@competitor-analysis" ;;
    "document-formatter") echo "ntaksh42/agents@document-formatter" ;;
    "davila7/xlsx") echo "anthropics/skills@xlsx" ;;
    "openclaw/pptx-creator") echo "skillcreatorai/ai-agent-skills@pptx" ;;
    "meeting-notes") echo "shubhamsaboo/awesome-llm-apps@meeting-notes" ;;
    "email-writer") echo "modu-ai/smart-cowork-life@biz-email-writer" ;;
    *) echo "" ;;
  esac
}

echo "開始安裝 Smithery skills..."

for skill in "${SKILLS[@]}"; do
  echo "----------------------------------------"
  echo "Installing: $skill"
  package="$(resolve_skill_package "$skill")"

  if [ -n "$package" ] && [[ "$package" == *"@"* ]]; then
    echo "Resolved package: $package"
    install_cmd=(npx -y skills add "$package" -g -y)
  elif [ -n "$package" ]; then
    install_cmd=(npx -y @smithery/cli@latest skill add "$package")
  else
    echo "No canonical package mapping found."
    FAILED+=("$skill")
    continue
  fi

  if "${install_cmd[@]}"; then
    SUCCESS+=("$skill")
  else
    FAILED+=("$skill")
  fi
done

echo ""
echo "======== 安裝完成 ========"
echo "成功安裝: ${#SUCCESS[@]}"
if [ ${#SUCCESS[@]} -gt 0 ]; then
  for s in "${SUCCESS[@]}"; do
    echo "  - $s"
  done
fi

echo ""
echo "失敗安裝: ${#FAILED[@]}"
if [ ${#FAILED[@]} -gt 0 ]; then
  for f in "${FAILED[@]}"; do
    echo "  - $f"
  done
fi

print_risk_summary

if [ ${#FAILED[@]} -gt 0 ]; then
  exit 1
fi
