param([ValidateSet('drivers','constructors')][string]$Kind = 'drivers')
# Research only: CC0 labels are candidates, never automatically approved official names.
$ErrorActionPreference = 'Stop'
$locInventory = Get-Content -LiteralPath 'local-private/localization/inventory.json' -Raw | ConvertFrom-Json
$locRows = $locInventory.$Kind
$locPrefix = if ($Kind -eq 'drivers') { 'wikidata' } else { 'constructors-wikidata' }
for ($locOffset = 0; $locOffset -lt $locRows.Count; $locOffset += 40) {
  $locPath = "local-private/localization/$locPrefix-$locOffset.json"
  if (Test-Path -LiteralPath $locPath) { continue }
  $locTitles = @($locRows | Select-Object -Skip $locOffset -First 40 | ForEach-Object {
    $locUrl = [Uri]$_.sourceUrl
    if ($locUrl.Host -ne 'en.wikipedia.org') { throw "Unverified identity URL: $($_.id)" }
    [Uri]::UnescapeDataString($locUrl.AbsolutePath.Replace('/wiki/','')).Replace('_',' ')
  })
  $locQuery = [Uri]::EscapeDataString(($locTitles -join '|'))
  $locUrl = "https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&sites=enwiki&titles=$locQuery&props=labels%7Csitelinks&languages=zh%7Czh-cn%7Czh-hans%7Czh-tw&sitefilter=enwiki"
  for ($locAttempt = 0; $locAttempt -lt 3; $locAttempt++) {
    try {
      $locResponse = Invoke-WebRequest -Uri $locUrl -TimeoutSec 30 -Headers @{ 'User-Agent' = 'DriverGuess-localization-research/2.0' }
      $locParsed = $locResponse.Content | ConvertFrom-Json
      if (-not $locParsed.entities) { throw 'Wikidata returned no entities' }
      [IO.File]::WriteAllText((Join-Path (Get-Location) $locPath), $locResponse.Content, [Text.UTF8Encoding]::new($false))
      Write-Output "Cached $locOffset"
      Start-Sleep -Seconds 2
      break
    } catch {
      if ($locAttempt -eq 2) { throw }
      # Respect upstream backoff. Fail after bounded retries; never skip a failed page.
      Start-Sleep -Seconds ([Math]::Min(60, 20 * ($locAttempt + 1)))
    }
  }
}
