param([switch]$NoBrowser)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = (Resolve-Path -LiteralPath $root).Path
$rootSep = $root.TrimEnd('\') + '\'

function Get-Mime([string]$path) {
    switch ([System.IO.Path]::GetExtension($path).ToLowerInvariant()) {
        '.html' { 'text/html; charset=utf-8' }
        '.htm'  { 'text/html; charset=utf-8' }
        '.css'  { 'text/css; charset=utf-8' }
        '.js'   { 'text/javascript; charset=utf-8' }
        '.mjs'  { 'text/javascript; charset=utf-8' }
        '.json' { 'application/json; charset=utf-8' }
        '.svg'  { 'image/svg+xml' }
        '.png'  { 'image/png' }
        '.jpg'  { 'image/jpeg' }
        '.jpeg' { 'image/jpeg' }
        '.webp' { 'image/webp' }
        '.gif'  { 'image/gif' }
        '.ico'  { 'image/x-icon' }
        '.pdf'  { 'application/pdf' }
        '.txt'  { 'text/plain; charset=utf-8' }
        default { 'application/octet-stream' }
    }
}

$listener = $null
$port = 0
for ($p = 8765; $p -lt 8790; $p++) {
    $candidate = $null
    try {
        $candidate = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $p)
        $candidate.Start()
        $listener = $candidate
        $port = $p
        break
    } catch {
        if ($candidate) {
            try { $candidate.Stop() } catch { }
        }
    }
}

if (-not $listener) {
    Write-Host "无法启动本地服务器：端口 8765-8789 都被占用。" -ForegroundColor Red
    exit 1
}

$url = "http://127.0.0.1:$port/"
Write-Host ""
Write-Host "  TabFlow 已启动" -ForegroundColor Cyan
Write-Host "  $url" -ForegroundColor Green
Write-Host ""
Write-Host "  按 Ctrl+C 停止服务器" -ForegroundColor DarkGray
Write-Host ""

if (-not $NoBrowser) {
    try { Start-Process $url } catch { }
}

while ($true) {
    $client = $null
    try {
        $client = $listener.AcceptTcpClient()
        $stream = $client.GetStream()
        $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::ASCII, $false, 4096, $true)
        $requestLine = $reader.ReadLine()

        if ([string]::IsNullOrWhiteSpace($requestLine)) {
            $client.Close()
            continue
        }

        $parts = $requestLine.Split(' ')
        $method = $parts[0]
        $rawPath = $parts[1]

        while ($true) {
            $line = $reader.ReadLine()
            if ($null -eq $line -or $line -eq '') { break }
        }

        $path = ($rawPath -split '\?')[0]
        $path = [System.Uri]::UnescapeDataString($path)
        if ([string]::IsNullOrEmpty($path) -or $path -eq '/') {
            $path = '/index.html'
        }

        $rel = $path.TrimStart('/') -replace '/', '\'
        $full = [System.IO.Path]::GetFullPath((Join-Path $root $rel))

        $status = '200 OK'
        $contentType = 'text/plain; charset=utf-8'
        $body = $null

        if (-not $full.StartsWith($rootSep, [System.StringComparison]::OrdinalIgnoreCase)) {
            $status = '403 Forbidden'
            $body = [System.Text.Encoding]::UTF8.GetBytes('403 Forbidden')
        } elseif (Test-Path -LiteralPath $full -PathType Leaf) {
            $contentType = Get-Mime $full
            $body = [System.IO.File]::ReadAllBytes($full)
        } else {
            $status = '404 Not Found'
            $body = [System.Text.Encoding]::UTF8.GetBytes('404 Not Found')
        }

        $header = "HTTP/1.1 $status`r`nContent-Type: $contentType`r`nContent-Length: $($body.Length)`r`nCache-Control: no-store`r`nConnection: close`r`n`r`n"
        $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($header)
        $stream.Write($headerBytes, 0, $headerBytes.Length)

        if ($method -ne 'HEAD') {
            $stream.Write($body, 0, $body.Length)
        }

        $stream.Flush()
    } catch {
        # 忽略单个请求的错误，继续服务。
    } finally {
        if ($client) {
            try { $client.Close() } catch { }
        }
    }
}
