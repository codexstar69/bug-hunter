#!/usr/bin/env node
'use strict';

/**
 * dep-scan.cjs — Dependency CVE scanner for Bug Hunter v3
 *
 * Detects package manager, runs audit, filters HIGH/CRITICAL,
 * searches codebase for usage of vulnerable APIs, classifies reachability.
 *
 * Usage: node dep-scan.cjs --target <path> --output <path>
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--target' && argv[i + 1]) {
      args.target = argv[i + 1];
      i += 1;
      continue;
    }

    if (argv[i] === '--output' && argv[i + 1]) {
      args.output = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

function runCommand({ command, cwd, timeout = 90000 }) {
  const result = spawnSync('bash', ['-c', command], {
    cwd,
    encoding: 'utf8',
    timeout,
  });

  const stdout = (result.stdout || '').trim();
  const stderr = (result.stderr || '').trim();
  const timeoutHit = result.signal === 'SIGTERM' && Boolean(result.error);

  return {
    ok: result.status === 0,
    status: result.status,
    signal: result.signal,
    timedOut: timeoutHit,
    stdout,
    stderr,
    errorMessage: result.error ? String(result.error.message || result.error) : '',
  };
}

function detectEcosystems(targetDir) {
  const checks = [
    { lockfile: 'package-lock.json', ecosystem: 'node', manager: 'npm', command: 'npm audit --json' },
    { lockfile: 'pnpm-lock.yaml', ecosystem: 'node', manager: 'pnpm', command: 'pnpm audit --json' },
    { lockfile: 'yarn.lock', ecosystem: 'node', manager: 'yarn', command: 'yarn npm audit --json' },
    { lockfile: 'bun.lockb', ecosystem: 'node', manager: 'bun', command: 'bun audit --json' },
    { lockfile: 'bun.lock', ecosystem: 'node', manager: 'bun', command: 'bun audit --json' },
    { lockfile: 'requirements.txt', ecosystem: 'pip', manager: 'pip', command: 'pip-audit --format json' },
    { lockfile: 'Pipfile.lock', ecosystem: 'pip', manager: 'pipenv', command: 'pip-audit --format json' },
    { lockfile: 'go.sum', ecosystem: 'go', manager: 'go', command: 'govulncheck -json ./...' },
    { lockfile: 'Cargo.lock', ecosystem: 'rust', manager: 'cargo', command: 'cargo audit --json' },
  ];

  return checks.filter((check) => {
    return fs.existsSync(path.join(targetDir, check.lockfile));
  });
}

function parseJsonFromOutput(raw) {
  if (!raw || raw.trim() === '') {
    return null;
  }

  const trimmed = raw.trim();

  try {
    return JSON.parse(trimmed);
  } catch {
    // Continue with fallback parsing.
  }

  const lines = trimmed.split('\n').map((line) => {
    return line.trim();
  }).filter(Boolean);

  const jsonLine = lines.find((line) => {
    return line.startsWith('{') || line.startsWith('[');
  });

  if (jsonLine) {
    try {
      return JSON.parse(jsonLine);
    } catch {
      // Continue with brace slicing fallback.
    }
  }

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const candidate = trimmed.slice(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(candidate);
    } catch {
      return null;
    }
  }

  return null;
}

function extractNodeFindings(data) {
  const vulnerabilityEntries = Object.entries(data.vulnerabilities || {});
  const fromVulnerabilities = vulnerabilityEntries
    .map(([packageName, info]) => {
      const severity = String(info?.severity || '').toUpperCase();
      if (severity !== 'HIGH' && severity !== 'CRITICAL') {
        return null;
      }

      const viaEntry = Array.isArray(info.via) ? info.via.find((entry) => {
        return typeof entry === 'object';
      }) : null;

      return {
        package: packageName,
        version: info.range || info.version || 'unknown',
        severity,
        cve: viaEntry?.cve || viaEntry?.url || 'N/A',
        fixed_version: info.fixAvailable?.version || 'unknown',
        title: viaEntry?.title || (typeof info.via?.[0] === 'string' ? info.via[0] : packageName),
      };
    })
    .filter(Boolean);

  if (fromVulnerabilities.length > 0) {
    return fromVulnerabilities;
  }

  const advisoryEntries = Object.entries(data.advisories || {});
  return advisoryEntries
    .map(([, advisory]) => {
      const severity = String(advisory?.severity || '').toUpperCase();
      if (severity !== 'HIGH' && severity !== 'CRITICAL') {
        return null;
      }

      return {
        package: advisory.module_name,
        version: advisory.findings?.[0]?.version || 'unknown',
        severity,
        cve: advisory.cves?.[0] || advisory.url || 'N/A',
        fixed_version: advisory.patched_versions || 'unknown',
        title: advisory.title || advisory.module_name,
      };
    })
    .filter(Boolean);
}

function extractFindingsByEcosystem({ ecosystem, manager, rawOutput }) {
  const data = parseJsonFromOutput(rawOutput);
  if (!data) {
    return {
      findings: [],
      parseError: `Could not parse JSON output for ${ecosystem}/${manager}`,
    };
  }

  if (ecosystem === 'node') {
    return { findings: extractNodeFindings(data), parseError: null };
  }

  // TODO: add richer parsers for pip/go/rust outputs.
  return {
    findings: [],
    parseError: null,
  };
}

function searchReachability({ targetDir, packageName }) {
  const escapedPackage = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const importPattern = `(require\\(|from\\s+)['"]${escapedPackage}`;
  const result = spawnSync('rg', [
    '-l', importPattern, targetDir,
    '--type-add', 'src:*.{js,ts,jsx,tsx,py,go,rs}',
    '-t', 'src'
  ], {
    cwd: targetDir,
    encoding: 'utf8',
    timeout: 20000,
  });
  const searchResult = {
    ok: result.status === 0,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
  };

  if (!searchResult.ok || !searchResult.stdout) {
    return { reachability: 'NOT_REACHABLE', evidence: 'No imports found in source files' };
  }

  const files = searchResult.stdout.split('\n').filter(Boolean);
  const nonTestFiles = files.filter((filePath) => {
    return !filePath.includes('.test.') && !filePath.includes('.spec.') && !filePath.includes('__tests__');
  });

  if (nonTestFiles.length > 0) {
    const suffix = nonTestFiles.length > 3 ? ` (+${nonTestFiles.length - 3} more)` : '';
    return {
      reachability: 'REACHABLE',
      evidence: `Imported in: ${nonTestFiles.slice(0, 3).join(', ')}${suffix}`,
    };
  }

  return {
    reachability: 'POTENTIALLY_REACHABLE',
    evidence: `Only imported in test files: ${files.slice(0, 2).join(', ')}`,
  };
}

function writeOutput({ outputPath, payload }) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2));
}

function main() {
  const args = parseArgs(process.argv);
  const targetDir = path.resolve(args.target || '.');
  const outputPath = path.resolve(args.output || '.bug-hunter/dep-findings.json');

  const ecosystems = detectEcosystems(targetDir);

  if (ecosystems.length === 0) {
    const result = {
      scan_date: new Date().toISOString(),
      ecosystems: [],
      lockfiles: [],
      findings: [],
      summary: {
        total: 0,
        reachable: 0,
        potentially_reachable: 0,
        not_reachable: 0,
      },
      scan_errors: [
        {
          manager: 'none',
          lockfile: 'none',
          reason: 'No supported lockfile found (package-lock.json, pnpm-lock.yaml, yarn.lock, bun.lockb, bun.lock, requirements.txt, go.sum, Cargo.lock)',
        },
      ],
    };

    writeOutput({ outputPath, payload: result });
    console.log('dep-scan: No supported lockfile found.');
    return;
  }

  const scanErrors = [];
  const allFindings = [];

  ecosystems.forEach((eco) => {
    console.log(`dep-scan: Running ${eco.command} in ${targetDir}...`);
    const runResult = runCommand({ command: eco.command, cwd: targetDir });

    const combinedOutput = [runResult.stdout, runResult.stderr].filter(Boolean).join('\n');

    if (!runResult.ok && combinedOutput.trim() === '') {
      scanErrors.push({
        manager: eco.manager,
        lockfile: eco.lockfile,
        reason: runResult.errorMessage || `Command failed with status ${String(runResult.status)}`,
      });
      return;
    }

    const { findings, parseError } = extractFindingsByEcosystem({
      ecosystem: eco.ecosystem,
      manager: eco.manager,
      rawOutput: combinedOutput,
    });

    if (parseError) {
      scanErrors.push({
        manager: eco.manager,
        lockfile: eco.lockfile,
        reason: parseError,
      });
    }

    const shouldTreatNonZeroAsError = !runResult.ok && (parseError || findings.length === 0);
    if (shouldTreatNonZeroAsError) {
      scanErrors.push({
        manager: eco.manager,
        lockfile: eco.lockfile,
        reason: runResult.stderr || runResult.errorMessage || `Command failed with status ${String(runResult.status)}`,
      });
    }

    findings.forEach((finding) => {
      const reach = searchReachability({ targetDir, packageName: finding.package });
      allFindings.push({
        id: `DEP-${String(allFindings.length + 1).padStart(3, '0')}`,
        ecosystem: eco.ecosystem,
        manager: eco.manager,
        lockfile: eco.lockfile,
        ...finding,
        ...reach,
      });
    });
  });

  const summary = {
    total: allFindings.length,
    reachable: allFindings.filter((finding) => {
      return finding.reachability === 'REACHABLE';
    }).length,
    potentially_reachable: allFindings.filter((finding) => {
      return finding.reachability === 'POTENTIALLY_REACHABLE';
    }).length,
    not_reachable: allFindings.filter((finding) => {
      return finding.reachability === 'NOT_REACHABLE';
    }).length,
  };

  const result = {
    scan_date: new Date().toISOString(),
    ecosystems: [...new Set(ecosystems.map((eco) => eco.ecosystem))],
    lockfiles: ecosystems.map((eco) => eco.lockfile),
    findings: allFindings,
    summary,
    scan_errors: scanErrors,
  };

  writeOutput({ outputPath, payload: result });

  console.log(
    `dep-scan: ${summary.total} HIGH/CRITICAL CVEs | ${summary.reachable} reachable, ${summary.potentially_reachable} potentially reachable, ${summary.not_reachable} not reachable`
  );

  if (scanErrors.length > 0) {
    console.log(`dep-scan: ${scanErrors.length} scan error(s) recorded (see scan_errors in ${outputPath})`);
  }

  console.log(`dep-scan: Output written to ${outputPath}`);
}

main();
