# Speaks each narration sentence to its own WAV file with the built-in Windows voice.
# Usage: powershell -NoProfile -File demo/speak.ps1 <output-folder>
param([Parameter(Mandatory = $true)][string]$OutDir)

Add-Type -AssemblyName System.Speech
$narration = Get-Content -Raw -Encoding UTF8 (Join-Path $PSScriptRoot 'narration.json') | ConvertFrom-Json
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.SelectVoice($narration.voice)
$synth.Rate = $narration.rate
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(44100, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)

for ($s = 0; $s -lt $narration.scenes.Count; $s++) {
  $sentences = $narration.scenes[$s].sentences
  for ($i = 0; $i -lt $sentences.Count; $i++) {
    $spoken = if ($sentences[$i].say) { $sentences[$i].say } else { $sentences[$i].text }
    $synth.SetOutputToWaveFile((Join-Path $OutDir ("{0:d2}-{1:d2}.wav" -f $s, $i)), $format)
    $synth.Speak($spoken)
  }
}
$synth.SetOutputToNull()
$synth.Dispose()
