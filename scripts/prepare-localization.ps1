# Build factual display configuration from cached CC0 labels; no database writes.
$ErrorActionPreference = 'Stop'
$locInventory = Get-Content -LiteralPath 'local-private/localization/inventory.json' -Raw | ConvertFrom-Json
$locResult = [ordered]@{ revision = 'zh-2026-10-16-2'; drivers = [ordered]@{}; constructors = [ordered]@{} }
foreach ($locKind in @('drivers','constructors')) {
  $locPrefix = if ($locKind -eq 'drivers') { 'wikidata' } else { 'constructors-wikidata' }
  $locEntities = @{}
  foreach ($locFile in Get-ChildItem "local-private/localization/$locPrefix-*.json") {
    foreach ($locEntity in (Get-Content -LiteralPath $locFile.FullName -Raw | ConvertFrom-Json -AsHashtable).entities.Values) {
      if ($locEntity.sitelinks.enwiki.title) { $locEntities[$locEntity.sitelinks.enwiki.title] = $locEntity }
    }
  }
  if ($locKind -eq 'drivers') {
    $locRedirectEntities = @{}
    foreach ($locFile in Get-ChildItem 'local-private/localization/redirect-labels-*.json' -ErrorAction SilentlyContinue) {
      foreach ($locEntity in (Get-Content -LiteralPath $locFile.FullName -Raw | ConvertFrom-Json -AsHashtable).entities.Values) {
        if ($locEntity.id) { $locRedirectEntities[$locEntity.id] = $locEntity }
      }
    }
    foreach ($locFile in Get-ChildItem 'local-private/localization/redirects-*.json' -ErrorAction SilentlyContinue) {
      $locQuery = (Get-Content -LiteralPath $locFile.FullName -Raw | ConvertFrom-Json -AsHashtable).query
      $locTitleItems = @{}
      foreach ($locPage in $locQuery.pages.Values) {
        if ($locPage.pageprops.wikibase_item) { $locTitleItems[$locPage.title] = $locPage.pageprops.wikibase_item }
      }
      foreach ($locRedirect in $locQuery.redirects) {
        $locTarget = $locRedirect.to
        $locVisited = @($locRedirect.from)
        while ($locQuery.redirects | Where-Object { $_.from -ceq $locTarget }) {
          if ($locVisited -contains $locTarget) { throw 'Identity redirect cycle' }
          $locVisited += $locTarget
          $locTarget = ($locQuery.redirects | Where-Object { $_.from -ceq $locTarget } | Select-Object -First 1).to
        }
        $locItem = $locTitleItems[$locTarget]
        if ($locItem -and $locRedirectEntities[$locItem]) { $locEntities[$locRedirect.from] = $locRedirectEntities[$locItem] }
      }
    }
  }
  foreach ($locRow in $locInventory.$locKind) {
    $locTitle = [Uri]::UnescapeDataString(([Uri]$locRow.sourceUrl).AbsolutePath.Replace('/wiki/','')).Replace('_',' ')
    $locEntity = $locEntities[$locTitle]
    if (-not $locEntity -or -not $locEntity.labels) { continue }
    $locName = $null
    foreach ($locLanguage in @('zh-cn','zh-hans','zh')) {
      if ($locEntity.labels[$locLanguage].value -match '\p{IsCJKUnifiedIdeographs}') { $locName = $locEntity.labels[$locLanguage].value; break }
    }
    if (-not $locName) { continue }
    # Script conversion only: preserve the original label as a searchable spelling.
    $locSimplified = [Microsoft.VisualBasic.Strings]::StrConv($locName,[Microsoft.VisualBasic.VbStrConv]::SimplifiedChinese,2052)
    $locAliases = @($locEntity.labels.Values | ForEach-Object { $_.value } | Where-Object { $_ -match '\p{IsCJKUnifiedIdeographs}' } | Sort-Object -Unique)
    $locResult[$locKind][$locRow.id] = [ordered]@{ name = $locSimplified; aliases = $locAliases; source = "https://www.wikidata.org/wiki/$($locEntity.id)"; status = 'community'; identity = $locRow.sourceUrl; resolvedIdentity = ('https://en.wikipedia.org/wiki/' + [Uri]::EscapeDataString($locEntity.sitelinks.enwiki.title.Replace(' ','_'))) }
  }
}
$locExisting = Get-Content -LiteralPath 'data/aliases/drivers.zh.json' -Raw | ConvertFrom-Json
foreach ($locRow in $locExisting) {
  $locResult.drivers["jolpica:driver:$($locRow.externalId)"] = [ordered]@{ name = $locRow.displayName; aliases = @($locRow.aliases); source = $locRow.sourceUrl; status = 'owner-reviewed'; identity = "jolpica:driver:$($locRow.externalId)" }
}
# Chinese GP 2024 entry list: names only; no prose, images, statistics or team succession.
$locFia = 'https://www.fia.com/sites/default/files/media_kit_-_chinese_gp.pdf#page=24'
$locModern = @{
  max_verstappen = @('麦克斯·维斯塔潘','马克斯·维斯塔潘','维斯塔潘'); perez = @('塞尔吉奥·佩雷兹','佩雷兹'); russell = @('乔治·拉塞尔','拉塞尔');
  leclerc = @('夏尔·勒克莱尔','勒克莱尔'); sainz = @('卡洛斯·塞恩斯','卡洛斯·赛恩斯','塞恩斯','赛恩斯'); piastri = @('奥斯卡·皮亚斯特里','皮亚斯特里');
  norris = @('兰多·诺里斯','诺里斯'); stroll = @('兰斯·斯特罗尔','斯特罗尔'); ocon = @('埃斯特班·奥康','奥康'); gasly = @('皮埃尔·加斯利','加斯利');
  albon = @('亚历山大·阿尔本','阿尔本'); sargeant = @('洛甘·萨金特','萨金特'); ricciardo = @('丹尼尔·里卡多','里卡多'); tsunoda = @('角田裕毅');
  zhou = @('周冠宇'); bottas = @('瓦尔特利·博塔斯','瓦尔特里·博塔斯','博塔斯'); kevin_magnussen = @('凯文·马格努森','马格努森'); hulkenberg = @('尼科·霍肯伯格','尼科·霍肯博格','霍肯伯格','霍肯博格')
}
foreach ($locId in $locModern.Keys) {
  $locKey = "jolpica:driver:$locId"
  if (-not ($locInventory.drivers.id -contains $locKey)) { throw "Unknown modern driver $locId" }
  $locPrior = $locResult.drivers[$locKey]
  $locNames = $locModern[$locId]
  $locResult.drivers[$locKey] = [ordered]@{ name = $locNames[0]; aliases = @(@($locNames) + @($locPrior.aliases) | Where-Object { $_ } | Sort-Object -Unique); source = $locFia; status = 'source-attested'; identity = $locKey }
  if ($locPrior -and $locPrior.source -ne $locFia) { $locResult.drivers[$locKey].additionalSources = @($locPrior.source) }
}
# Mainland spelling attested in the manufacturer's Chinese Senna/McLaren booklet.
$locSenna = $locResult.drivers['jolpica:driver:senna']
$locResult.drivers['jolpica:driver:senna'] = [ordered]@{
  name = '埃尔顿·塞纳'
  aliases = @(@('埃尔顿·塞纳','艾尔顿·塞纳','塞纳') + @($locSenna.aliases) | Sort-Object -Unique)
  source = 'https://www.lego.com/cdn/product-assets/product.bi.additional.main.pdf/10330_ZH_BI_Build_Translate.pdf'
  status = 'source-attested'
  identity = 'jolpica:driver:senna'
  additionalSources = @($locSenna.source)
}
# Exact constructor IDs only. Identical display names never merge constructor identities.
$locTeams = @{ ferrari='法拉利'; mercedes='梅赛德斯'; mclaren='迈凯伦'; red_bull='红牛'; aston_martin='阿斯顿·马丁'; williams='威廉姆斯'; sauber='索伯'; haas='哈斯' }
foreach ($locId in $locTeams.Keys) {
  $locKey = "jolpica:constructor:$locId"
  if (-not ($locInventory.constructors.id -contains $locKey)) { throw "Unknown constructor $locId" }
  $locResult.constructors[$locKey] = [ordered]@{ name = $locTeams[$locId]; aliases = @(); source = $locFia; status = 'source-attested'; identity = $locKey }
}
# Explicit closeout decisions override automated labels. Never resurrect a withdrawn alias.
$locReviews = Get-Content -LiteralPath 'data/aliases/drivers.zh-reviews.json' -Raw | ConvertFrom-Json
foreach ($locReview in $locReviews.decisions) {
  $locPrior = $locResult.drivers[$locReview.driverId]
  if (-not $locPrior -or $locPrior.name -cne $locReview.previousName) { throw "Review input changed: $($locReview.driverId)" }
  if ($locReview.action -eq 'english-fallback') { $locResult.drivers.Remove($locReview.driverId); continue }
  if ($locReview.action -ne 'preferred-spelling') { throw 'Unknown localization review action' }
  $locResult.drivers[$locReview.driverId] = [ordered]@{
    name = $locReview.name
    aliases = @(@($locPrior.name) + @($locPrior.aliases) + @($locReview.name) | Sort-Object -Unique)
    source = $locReview.source
    status = $locReview.status
    identity = $locPrior.identity
    additionalSources = @($locPrior.source)
  }
}
$locJson = $locResult | ConvertTo-Json -Depth 12
$locOutput = "// Factual display labels only. See docs/localization.md for provenance and limitations.`nexport const LOCALIZATION_CATALOG = $locJson as const`n"
[IO.File]::WriteAllText((Join-Path (Get-Location) 'packages/shared/src/localization-catalog.ts'), $locOutput, [Text.UTF8Encoding]::new($false))
Write-Output "Prepared drivers=$($locResult.drivers.Count), constructors=$($locResult.constructors.Count)"
