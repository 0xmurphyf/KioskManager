[CmdletBinding()]
param(
    [string]$PackageId = '0x639d824b6a4de1b1491d69eaa79597336ab3be8dc9dff3bfd78cd333bf38a53b',
    [string]$Endpoint = 'https://graphql.testnet.sui.io/graphql',
    [string]$ClientConfig = "$env:USERPROFILE\.sui\sui_config\client.yaml",
    [ValidateRange(1, 50)]
    [int]$PageSize = 50,
    [switch]$SkipCertificateRevocationCheck
)

$ErrorActionPreference = 'Stop'
$eventType = "$PackageId::memory_archive::MemoryArchived"
$after = $null
$events = @()

do {
    $cursorArgument = if ($null -eq $after) { '' } else { ", after: `"$after`"" }
    $query = @"
query {
  events(first: $PageSize, filter: { type: "$eventType" }$cursorArgument) {
    nodes {
      contents { json }
      sender { address }
      timestamp
      transaction { digest }
    }
    pageInfo { hasNextPage endCursor }
  }
}
"@
    $payload = @{ query = $query } | ConvertTo-Json -Compress
    $curlArgs = @('--fail', '--silent', '--show-error', '-H', 'content-type: application/json', '--data-binary', '@-', $Endpoint)
    if ($SkipCertificateRevocationCheck) { $curlArgs = @('--ssl-no-revoke') + $curlArgs }

    $response = $payload | & curl.exe @curlArgs | ConvertFrom-Json
    if ($response.errors) { throw ($response.errors | ConvertTo-Json -Compress) }

    $events += $response.data.events.nodes
    $after = $response.data.events.pageInfo.endCursor
} while ($response.data.events.pageInfo.hasNextPage)

$archives = foreach ($event in $events) {
    $data = $event.contents.json
    $objectJson = & sui client --client.config $ClientConfig object $data.archive_id --json
    $object = $objectJson | ConvertFrom-Json

    [pscustomobject]@{
        archive_id = $data.archive_id
        original_object_id = $data.original_object_id
        archived_by = $data.archived_by
        archived_at_ms = $data.archived_at_ms
        archived_at_utc = ([DateTimeOffset]::FromUnixTimeMilliseconds([int64]$data.archived_at_ms)).UtcDateTime.ToString('o')
        policy_version = $data.policy_version
        storage_type = $data.storage_type
        event_transaction = $event.transaction.digest
        object_owner = $object.owner
        object_type = $object.objType
        object_version = $object.version
        content = $object.content
    }
}

$archives | ConvertTo-Json -Depth 12
