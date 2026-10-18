# Resolve existing English identity redirects only; never match by similar names.
$ErrorActionPreference = 'Stop'
$locMissing = @()
foreach ($locFile in Get-ChildItem 'local-private/localization/wikidata-*.json') {
  foreach ($locEntity in (Get-Content -LiteralPath $locFile.FullName -Raw | ConvertFrom-Json -AsHashtable).entities.Values) {
    if ($locEntity.ContainsKey('missing') -and $locEntity.title) { $locMissing += $locEntity.title }
  }
}
for ($locOffset = 0; $locOffset -lt $locMissing.Count; $locOffset += 40) {
  $locPath = "local-private/localization/redirects-$locOffset.json"
  if (Test-Path -LiteralPath $locPath) { continue }
  $locTitles = [Uri]::EscapeDataString((($locMissing | Select-Object -Skip $locOffset -First 40) -join '|'))
  $locUrl = "https://en.wikipedia.org/w/api.php?action=query&format=json&redirects=1&prop=pageprops&ppprop=wikibase_item&titles=$locTitles"
  $locResponse = Invoke-WebRequest -Uri $locUrl -TimeoutSec 30
  [IO.File]::WriteAllText((Join-Path (Get-Location) $locPath), $locResponse.Content, [Text.UTF8Encoding]::new($false))
  Write-Output "Resolved $locOffset"
  Start-Sleep -Seconds 2
}
$locIds = @()
foreach ($locFile in Get-ChildItem 'local-private/localization/redirects-*.json') {
  $locQuery = (Get-Content -LiteralPath $locFile.FullName -Raw | ConvertFrom-Json -AsHashtable).query
  foreach ($locPage in $locQuery.pages.Values) {
    if ($locPage.pageprops.wikibase_item) { $locIds += $locPage.pageprops.wikibase_item }
  }
}
$locIds = @($locIds | Sort-Object -Unique)
for ($locOffset = 0; $locOffset -lt $locIds.Count; $locOffset += 40) {
  $locPath = "local-private/localization/redirect-labels-$locOffset.json"
  if (Test-Path -LiteralPath $locPath) { continue }
  $locQuery = ($locIds | Select-Object -Skip $locOffset -First 40) -join '%7C'
  $locUrl = "https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&ids=$locQuery&props=labels%7Csitelinks&languages=zh%7Czh-cn%7Czh-hans%7Czh-tw&sitefilter=enwiki"
  $locResponse = Invoke-WebRequest -Uri $locUrl -TimeoutSec 30
  [IO.File]::WriteAllText((Join-Path (Get-Location) $locPath), $locResponse.Content, [Text.UTF8Encoding]::new($false))
  Write-Output "Labels $locOffset"
  Start-Sleep -Seconds 2
}
