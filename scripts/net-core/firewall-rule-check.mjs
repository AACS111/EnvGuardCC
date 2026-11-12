// Compare effective filters, not just names. Windows may normalize IPv6/CIDR notation.
export const FIREWALL_RULE_CHECK = String.raw`
function Normalize-GuardAddress($value) {
  $parts = ([string]$value).Split('/')
  if ($parts.Count -eq 2) {
    $ip = [System.Net.IPAddress]::Parse($parts[0]); $low = $ip.GetAddressBytes(); $high = $ip.GetAddressBytes()
    $prefix = [int]$parts[1]
    for ($i = 0; $i -lt $low.Length; $i++) {
      $bits = [Math]::Min(8, [Math]::Max(0, $prefix - $i * 8))
      $mask = (255 -shl (8 - $bits)) -band 255
      $low[$i] = $low[$i] -band $mask; $high[$i] = $high[$i] -bor (255 -bxor $mask)
    }
    $a = ([System.Net.IPAddress]::new($low)).ToString(); $b = ([System.Net.IPAddress]::new($high)).ToString()
    return "$a-$b"
  }
  $ends = ([string]$value).Split('-')
  try {
    $a = ([System.Net.IPAddress]::Parse($ends[0])).ToString()
    $b = if ($ends.Count -eq 2) { ([System.Net.IPAddress]::Parse($ends[1])).ToString() } else { $a }
    return "$a-$b"
  } catch { return ([string]$value).ToLowerInvariant() }
}
function Test-GuardValues($actual, $expected, $addresses = $false) {
  $a = @($actual | ForEach-Object { if ($addresses) { Normalize-GuardAddress $_ } else { ([string]$_).ToLowerInvariant().Replace('/', '\') } } | Sort-Object -Unique)
  $b = @($expected | ForEach-Object { if ($addresses) { Normalize-GuardAddress $_ } else { ([string]$_).ToLowerInvariant().Replace('/', '\') } } | Sort-Object -Unique)
  return (($a -join '|') -ceq ($b -join '|'))
}
function Test-GuardRule($rule, $program, $package, $protocol, $port, $addresses) {
  if (!$rule -or $rule.Enabled -ne 'True' -or $rule.Action -ne 'Block' -or $rule.Direction -ne 'Outbound' -or $rule.Profile -ne 'Any') { return $false }
  $app = $rule | Get-NetFirewallApplicationFilter -ErrorAction Stop
  $addr = $rule | Get-NetFirewallAddressFilter -ErrorAction Stop
  $ports = $rule | Get-NetFirewallPortFilter -ErrorAction Stop
  $service = $rule | Get-NetFirewallServiceFilter -ErrorAction Stop
  $iface = $rule | Get-NetFirewallInterfaceTypeFilter -ErrorAction Stop
  $alias = $rule | Get-NetFirewallInterfaceFilter -ErrorAction Stop
  $actualPackage = if ([string]::IsNullOrEmpty($app.Package)) { 'Any' } else { $app.Package }
  $actualProtocol = [string]$ports.Protocol
  if ($actualProtocol -eq '256') { $actualProtocol = 'Any' }
  if ($actualProtocol -eq '6') { $actualProtocol = 'TCP' }
  if ($actualProtocol -eq '17') { $actualProtocol = 'UDP' }
  return ((Test-GuardValues $app.Program $program) -and (Test-GuardValues $actualPackage $package) -and
    (Test-GuardValues $addr.RemoteAddress $addresses $true) -and (Test-GuardValues $addr.LocalAddress 'Any') -and
    (Test-GuardValues $actualProtocol $protocol) -and (Test-GuardValues $ports.RemotePort $port) -and
    (Test-GuardValues $ports.LocalPort 'Any') -and (Test-GuardValues $service.Service 'Any') -and
    (Test-GuardValues $iface.InterfaceType 'Any') -and (Test-GuardValues $alias.InterfaceAlias 'Any'))
}
`;
