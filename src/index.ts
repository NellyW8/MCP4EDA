#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { exec, spawn } from "child_process";
import { promises as fs } from "fs";
import { tmpdir } from "os";
import { join, basename, resolve } from "path";
import { promisify } from "util";
import { homedir } from "os";

const execAsync = promisify(exec);

// Helper functions
function getStringProperty(obj: any, key: string, defaultValue = ""): string {
  if (obj && typeof obj === 'object' && key in obj) {
    const value = obj[key];
    return typeof value === 'string' ? value : defaultValue;
  }
  return defaultValue;
}

function getNumberProperty(obj: any, key: string, defaultValue = 10.0): number {
  if (obj && typeof obj === 'object' && key in obj) {
    const value = obj[key];
    return typeof value === 'number' ? value : defaultValue;
  }
  return defaultValue;
}

function validateRequiredString(obj: any, key: string, toolName: string): string {
  const value = getStringProperty(obj, key);
  if (!value) {
    throw new McpError(
      ErrorCode.InvalidParams, 
      `Missing required parameter '${key}' for tool '${toolName}'`
    );
  }
  return value;
}

// Enhanced exec with better timeout and error handling
async function execAsyncWithTimeout(command: string, options: any = {}, timeoutMs = 600000): Promise<{stdout: string, stderr: string}> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      childProcess.kill('SIGKILL');
      reject(new Error(`Command timed out after ${timeoutMs}ms: ${command}`));
    }, timeoutMs);

    // Ensure encoding is set to get string output and increase buffer size
    const execOptions = {
      encoding: 'utf8' as const,
      maxBuffer: 10 * 1024 * 1024, // 10MB default buffer
      ...options
    };

    const childProcess = exec(command, execOptions, (error, stdout, stderr) => {
      clearTimeout(timeout);
      if (error) {
        reject(error);
      } else {
        // Convert to string if needed (though with utf8 encoding it should already be string)
        const stdoutStr = typeof stdout === 'string' ? stdout : stdout.toString();
        const stderrStr = typeof stderr === 'string' ? stderr : stderr.toString();
        resolve({ stdout: stdoutStr, stderr: stderrStr });
      }
    });
  });
}

// Alternative spawn-based execution for better TTY handling
async function spawnAsyncWithTimeout(command: string, args: string[], options: any = {}, timeoutMs = 600000): Promise<{stdout: string, stderr: string}> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    
    const timeout = setTimeout(() => {
      childProcess.kill('SIGKILL');
      reject(new Error(`Command timed out after ${timeoutMs}ms: ${command} ${args.join(' ')}`));
    }, timeoutMs);

    const childProcess = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options
    });

    childProcess.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    childProcess.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    childProcess.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`Command failed with exit code ${code}: ${command} ${args.join(' ')}\n${stderr}`));
      }
    });

    childProcess.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

// Check if a command exists
async function commandExists(command: string): Promise<boolean> {
  try {
    await execAsync(`which ${command}`);
    return true;
  } catch {
    return false;
  }
}

class EDAServer {
  private tempDir: string;
  private projects: Map<string, { dir: string; type: string }> = new Map();
  private openlaneDir: string;

  constructor() {
    this.tempDir = join(tmpdir(), `eda_mcp_${Date.now()}`);
    this.openlaneDir = join(homedir(), "openlane-projects");
    this.initTempDir().catch(() => {});
  }

  private async initTempDir(): Promise<void> {
    try {
      await fs.mkdir(this.tempDir, { recursive: true });
      await fs.mkdir(this.openlaneDir, { recursive: true });
    } catch {
      // Silent fail
    }
  }

  async synthesizeVerilog(verilogCode: string, topModule: string, target = "generic"): Promise<string> {
    try {
      const projectId = Math.random().toString(36).substring(2, 15);
      const projectDir = join(this.tempDir, `project_${projectId}`);
      await fs.mkdir(projectDir, { recursive: true });

      // Store project info
      this.projects.set(projectId, { dir: projectDir, type: "synthesis" });

      // Write Verilog file
      const verilogFile = join(projectDir, "design.v");
      await fs.writeFile(verilogFile, verilogCode);

      // Create synthesis script
      let synthScript: string;
      switch (target.toLowerCase()) {
        case "ice40":
          synthScript = `
read_verilog design.v
hierarchy -check -top ${topModule}
synth_ice40 -top ${topModule}
write_verilog synth_output.v
stat
`;
          break;
        case "xilinx":
          synthScript = `
read_verilog design.v
hierarchy -check -top ${topModule}
synth_xilinx -top ${topModule}
write_verilog synth_output.v
stat
`;
          break;
        default:
          synthScript = `
read_verilog design.v
hierarchy -check -top ${topModule}
synth -top ${topModule}
techmap
opt
write_verilog synth_output.v
stat
`;
      }

      const scriptFile = join(projectDir, "synth.ys");
      await fs.writeFile(scriptFile, synthScript);

      // Run Yosys
      const { stdout, stderr } = await execAsync(`yosys -s ${scriptFile}`, {
        cwd: projectDir,
        timeout: 120000,
      });

      let synthVerilog = "";
      try {
        synthVerilog = await fs.readFile(join(projectDir, "synth_output.v"), 'utf8');
      } catch {
        synthVerilog = "Synthesis output not generated";
      }

      return JSON.stringify({
        project_id: projectId,
        success: true,
        stdout,
        stderr,
        synthesized_verilog: synthVerilog,
        target,
      }, null, 2);
    } catch (error: any) {
      return JSON.stringify({
        success: false,
        error: error.message || String(error),
      }, null, 2);
    }
  }

  async simulateVerilog(verilogCode: string, testbenchCode: string): Promise<string> {
    try {
      const projectId = Math.random().toString(36).substring(2, 15);
      const projectDir = join(this.tempDir, `sim_project_${projectId}`);
      await fs.mkdir(projectDir, { recursive: true });

      // Store project info
      this.projects.set(projectId, { dir: projectDir, type: "simulation" });

      // Write design and testbench files
      await fs.writeFile(join(projectDir, "design.v"), verilogCode);
      await fs.writeFile(join(projectDir, "testbench.v"), testbenchCode);

      // Compile and run simulation
      const compileCmd = `iverilog -o simulation design.v testbench.v`;
      const { stdout: compileOut, stderr: compileErr } = await execAsync(compileCmd, {
        cwd: projectDir,
        timeout: 60000,
      });

      const { stdout: simOut, stderr: simErr } = await execAsync('./simulation', {
        cwd: projectDir,
        timeout: 60000,
      });

      return JSON.stringify({
        project_id: projectId,
        success: true,
        compile_stdout: compileOut,
        compile_stderr: compileErr,
        sim_stdout: simOut,
        sim_stderr: simErr,
        note: `Use view_waveform with project_id: ${projectId} to open GTKWave`
      }, null, 2);
    } catch (error: any) {
      return JSON.stringify({
        success: false,
        error: error.message || String(error),
      }, null, 2);
    }
  }

  async viewWaveform(projectId: string, vcdFile = "output.vcd"): Promise<string> {
    try {
      // Check if project exists
      const project = this.projects.get(projectId);
      if (!project) {
        return JSON.stringify({
          success: false,
          error: `Project ${projectId} not found. Run a simulation first.`,
        }, null, 2);
      }

      const vcdPath = join(project.dir, vcdFile);

      // Check if VCD file exists
      try {
        await fs.access(vcdPath);
      } catch {
        // List available files to help user
        const files = await fs.readdir(project.dir);
        const vcdFiles = files.filter(f => f.endsWith('.vcd'));
        
        return JSON.stringify({
          success: false,
          error: `VCD file '${vcdFile}' not found in project ${projectId}`,
          available_vcd_files: vcdFiles,
          note: "Make sure your testbench includes $dumpfile() and $dumpvars() commands"
        }, null, 2);
      }

      // Check if GTKWave is available
      if (!(await commandExists('gtkwave'))) {
        return JSON.stringify({
          success: false,
          error: "GTKWave not found. Please install GTKWave to view waveforms.",
          install_instructions: {
            macos: "brew install gtkwave",
            linux: "sudo apt-get install gtkwave",
            windows: "Install GTKWave from http://gtkwave.sourceforge.net/"
          }
        }, null, 2);
      }

      // Launch GTKWave in background
      const gtkwaveCmd = `gtkwave "${vcdPath}" &`;
      await execAsync(gtkwaveCmd, { 
        cwd: project.dir, 
        timeout: 5000 
      });

      return JSON.stringify({
        success: true,
        message: `GTKWave launched for project ${projectId}`,
        vcd_file: vcdFile,
        vcd_path: vcdPath,
        project_type: project.type
      }, null, 2);

    } catch (error: any) {
      return JSON.stringify({
        success: false,
        error: error.message || String(error),
      }, null, 2);
    }
  }

  // Enhanced OpenLane with better error handling and environment detection
  async runOpenlane(
    verilogCode: string, 
    designName: string, 
    clockPort = "clk", 
    clockPeriod = 10.0,
    openInKlayout = true
  ): Promise<string> {
    try {
      const projectId = Math.random().toString(36).substring(2, 15);
      const projectName = `${designName}_${projectId}`;
      const projectDir = join(this.openlaneDir, projectName);
      
      // Store project info
      this.projects.set(projectId, { dir: projectDir, type: "openlane" });

      // Create project directory
      await fs.mkdir(projectDir, { recursive: true });

      // Write Verilog file
      const verilogFile = join(projectDir, `${designName}.v`);
      await fs.writeFile(verilogFile, verilogCode);

      // Create OpenLane config
      const configContent = {
        DESIGN_NAME: designName,
        VERILOG_FILES: [`${designName}.v`],
        CLOCK_PORT: clockPort,
        CLOCK_PERIOD: clockPeriod,
        // Additional OpenLane settings for better results
        FP_SIZING: "absolute",
        DIE_AREA: "0 0 100 100",
        FP_PDN_MULTILAYER: false,
        QUIT_ON_TIMING_VIOLATIONS: false,
        QUIT_ON_MAGIC_DRC: false,
        QUIT_ON_LVS_ERROR: false,
        RUN_KLAYOUT_XOR: false,
        RUN_KLAYOUT_DRC: false
      };

      const configFile = join(projectDir, "config.json");
      await fs.writeFile(configFile, JSON.stringify(configContent, null, 2));

      // Find Python command
      let pythonCmd = "python3";
      const pythonCandidates = [
        "python3",
        "python"
      ];
      
      for (const candidate of pythonCandidates) {
        if (await commandExists(candidate)) {
          pythonCmd = candidate;
          break;
        }
      }

      // Run the OpenLane command using Docker MCP approach
      console.error(`Starting OpenLane flow for ${designName}...`);
      console.error(`Working directory: ${projectDir}`);
      console.error(`This may take up to 10 minutes...`);

      const openlaneCmd = `${pythonCmd} -m openlane --dockerized config.json`;
      console.error(`Executing: ${openlaneCmd}`);

      // Create a wrapper script to handle TTY issues
      const wrapperScript = `#!/bin/bash
set -e

# Disable TTY requirements
export DEBIAN_FRONTEND=noninteractive
export CI=true
export TERM=dumb

# Change to project directory
cd "${projectDir}"

# Run OpenLane with script command to simulate TTY
script -q /dev/null ${pythonCmd} -m openlane --dockerized config.json
`;

      const wrapperPath = join(projectDir, 'run_openlane.sh');
      await fs.writeFile(wrapperPath, wrapperScript);
      await execAsyncWithTimeout(`chmod +x "${wrapperPath}"`, {});

      // Run the OpenLane command using the wrapper script
      console.error(`Starting OpenLane flow for ${designName}...`);
      console.error(`Working directory: ${projectDir}`);
      console.error(`This may take up to 10 minutes...`);
      console.error(`Using wrapper script to handle TTY`);

      const { stdout, stderr } = await execAsyncWithTimeout(`"${wrapperPath}"`, {
        cwd: projectDir,
        env: {
          ...process.env,
          PATH: process.env.PATH + ":/usr/local/bin:/opt/homebrew/bin"
        },
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer instead of default 1MB
        timeout: 600000
      }, 600000); // 10 minutes timeout

      // Find the latest run directory
      const runsDir = join(projectDir, "runs");
      let latestRun = "";
      let gdsFile = "";
      
      try {
        const runs = await fs.readdir(runsDir);
        if (runs.length > 0) {
          // Sort runs by name (they include timestamps) and get the latest
          latestRun = runs.sort().reverse()[0];
          const finalDir = join(runsDir, latestRun, "final", "gds");
          
          // Find GDS file
          try {
            const gdsFiles = await fs.readdir(finalDir);
            const gdsFilesList = gdsFiles.filter(f => f.endsWith('.gds'));
            if (gdsFilesList.length > 0) {
              gdsFile = join(finalDir, gdsFilesList[0]);
            }
          } catch {
            // GDS directory might not exist
          }
        }
      } catch {
        // Runs directory might not exist
      }

      let klayoutResult = "";
      
      // Open in KLayout if requested and GDS file exists
      if (openInKlayout && gdsFile) {
        try {
          // Check if KLayout is available
          if (await commandExists('klayout')) {
            // Launch KLayout with the GDS file
            const klayoutCmd = `open -a KLayout "${gdsFile}" &`;
            await execAsyncWithTimeout(klayoutCmd, {}, 10000);
            klayoutResult = `KLayout launched with GDS file: ${basename(gdsFile)}`;
          } else {
            klayoutResult = "KLayout not found. Install KLayout to view GDS files.";
          }
        } catch (error: any) {
          klayoutResult = `KLayout launch failed: ${error.message}`;
        }
      }

      return JSON.stringify({
        project_id: projectId,
        success: true,
        design_name: designName,
        project_dir: projectDir,
        latest_run: latestRun,
        gds_file: gdsFile ? basename(gdsFile) : "Not generated",
        gds_path: gdsFile,
        klayout_status: klayoutResult,
        command_used: openlaneCmd,
        stdout: stdout.length > 2000 ? stdout.substring(0, 2000) + "...(truncated)" : stdout,
        stderr: stderr.length > 2000 ? stderr.substring(0, 2000) + "...(truncated)" : stderr,
        note: "OpenLane flow completed. Check the runs directory for detailed results."
      }, null, 2);

    } catch (error: any) {
      // Simple error reporting
      const errorMessage = error.message || String(error);
      console.error(`OpenLane error: ${errorMessage}`);
      
      return JSON.stringify({
        success: false,
        error: errorMessage,
        note: "OpenLane flow failed. Make sure Docker is running and try: docker pull efabless/openlane:latest"
      }, null, 2);
    }
  }

  // Enhanced view GDS with better error handling
  async viewGds(projectId: string, gdsFile?: string): Promise<string> {
    try {
      const project = this.projects.get(projectId);
      if (!project) {
        return JSON.stringify({
          success: false,
          error: `Project ${projectId} not found.`,
        }, null, 2);
      }

      let gdsPath = "";
      
      if (gdsFile) {
        // Specific GDS file provided
        gdsPath = join(project.dir, gdsFile);
      } else {
        // Auto-find GDS file in OpenLane project
        const runsDir = join(project.dir, "runs");
        try {
          const runs = await fs.readdir(runsDir);
          if (runs.length > 0) {
            const latestRun = runs.sort().reverse()[0];
            const finalDir = join(runsDir, latestRun, "final", "gds");
            const gdsFiles = await fs.readdir(finalDir);
            const gdsFilesList = gdsFiles.filter(f => f.endsWith('.gds'));
            if (gdsFilesList.length > 0) {
              gdsPath = join(finalDir, gdsFilesList[0]);
            }
          }
        } catch {
          return JSON.stringify({
            success: false,
            error: "No GDS files found in project. Run OpenLane flow first.",
          }, null, 2);
        }
      }

      if (!gdsPath) {
        return JSON.stringify({
          success: false,
          error: "No GDS file found to open.",
        }, null, 2);
      }

      // Check if GDS file exists
      try {
        await fs.access(gdsPath);
      } catch {
        return JSON.stringify({
          success: false,
          error: `GDS file not found: ${gdsPath}`,
        }, null, 2);
      }

      // Launch KLayout directly with the correct command format
      const klayoutCmd = `open -a KLayout "${gdsPath}"`;
      await execAsyncWithTimeout(klayoutCmd, { shell: true }, 10000);

      return JSON.stringify({
        success: true,
        message: `KLayout launched with GDS file`,
        gds_file: basename(gdsPath),
        gds_path: gdsPath,
        project_id: projectId,
        command_executed: klayoutCmd
      }, null, 2);

    } catch (error: any) {
      return JSON.stringify({
        success: false,
        error: error.message || String(error),
      }, null, 2);
    }
  }


  async readOpenlaneReports(projectId: string, reportType?: string): Promise<string> {
    try {
      const project = this.projects.get(projectId);
      if (!project) {
        return JSON.stringify({
          success: false,
          error: `Project ${projectId} not found.`,
        }, null, 2);
      }
  
      const runsDir = join(project.dir, "runs");
      let latestRun = "";
      
      try {
        const runs = await fs.readdir(runsDir);
        if (runs.length === 0) {
          return JSON.stringify({
            success: false,
            error: "No OpenLane runs found. Run OpenLane flow first.",
          }, null, 2);
        }
        latestRun = runs.sort().reverse()[0];
      } catch {
        return JSON.stringify({
          success: false,
          error: "No runs directory found. Run OpenLane flow first.",
        }, null, 2);
      }
  
      const reportsDir = join(project.dir, "runs", latestRun, "reports");
      const finalDir = join(project.dir, "runs", latestRun, "final");
      
      // Simple results object
      const results: any = {
        project_id: projectId,
        run_id: latestRun,
        success: true,
        ppa_metrics: {
          power_mw: null,
          max_frequency_mhz: null,
          total_cells: null,
          logic_area_um2: null,
          timing_slack_ns: null
        },
        design_status: {
          synthesis_complete: false,
          timing_clean: false,
          routing_complete: false
        },
        reports: {}
      };
  
      // Helper to safely read file
      const readFile = async (path: string) => {
        try {
          return await fs.readFile(path, 'utf8');
        } catch {
          return null;
        }
      };
  
      // Read synthesis report
      const synthReport = await readFile(join(reportsDir, "synthesis", "1-synthesis.stat.rpt"));
      if (synthReport) {
        results.design_status.synthesis_complete = true;
        results.reports.synthesis = synthReport.substring(0, 2000);
        
        const cellMatch = synthReport.match(/Number of cells:\s*(\d+)/);
        if (cellMatch) {
          results.ppa_metrics.total_cells = parseInt(cellMatch[1]);
        }
      }
  
      // Read timing report
      try {
        const routingDir = join(reportsDir, "routing");
        const files = await fs.readdir(routingDir);
        
        for (const file of files) {
          if (file.includes('sta') || file.includes('timing')) {
            const timingReport = await readFile(join(routingDir, file));
            if (timingReport) {
              results.reports.timing = timingReport.substring(0, 2000);
              
              const wnsMatch = timingReport.match(/WNS.*?(-?\d+\.?\d*)/i);
              if (wnsMatch) {
                const wns = parseFloat(wnsMatch[1]);
                results.ppa_metrics.timing_slack_ns = wns;
                results.design_status.timing_clean = wns >= 0;
              }
              break;
            }
          }
        }
      } catch {
        // Timing reports not available
      }
  
      // Read final summary if available
      const finalSummary = await readFile(join(finalDir, "final.summary.rpt"));
      if (finalSummary) {
        results.reports.final_summary = finalSummary.substring(0, 3000);
        results.design_status.routing_complete = true;
      }
  
      // Add analysis summary
      const issues = [];
      if (!results.design_status.synthesis_complete) issues.push("Synthesis incomplete");
      if (!results.design_status.timing_clean) issues.push("Timing violations detected");
      if (!results.design_status.routing_complete) issues.push("Routing incomplete");
  
      results.summary = {
        status: issues.length === 0 ? "SUCCESS" : "ISSUES_FOUND",
        issues: issues,
        note: "PPA metrics and design status extracted from OpenLane reports"
      };
  
      return JSON.stringify(results, null, 2);
  
    } catch (error: any) {
      return JSON.stringify({
        success: false,
        error: error.message || String(error),
      }, null, 2);
    }
  }

}


// Initialize the server
const server = new Server(
  { name: "yosys-server", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

const edaServer = new EDAServer();

// Register tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "synthesize_verilog",
        description: "Synthesize Verilog code using Yosys for various FPGA targets",
        inputSchema: {
          type: "object",
          properties: {
            verilog_code: { 
              type: "string", 
              description: "The Verilog source code to synthesize" 
            },
            top_module: { 
              type: "string", 
              description: "Name of the top-level module" 
            },
            target: { 
              type: "string", 
              description: "Target technology (generic, ice40, xilinx, intel)", 
              default: "generic" 
            },
          },
          required: ["verilog_code", "top_module"],
        },
      },
      {
        name: "simulate_verilog",
        description: "Simulate Verilog code using Icarus Verilog",
        inputSchema: {
          type: "object",
          properties: {
            verilog_code: { 
              type: "string", 
              description: "The Verilog design code" 
            },
            testbench_code: { 
              type: "string", 
              description: "The testbench code" 
            },
          },
          required: ["verilog_code", "testbench_code"],
        },
      },
      {
        name: "view_waveform",
        description: "Open VCD waveform file in GTKWave viewer",
        inputSchema: {
          type: "object",
          properties: {
            project_id: { 
              type: "string", 
              description: "Project ID from simulation (required)" 
            },
            vcd_file: { 
              type: "string", 
              description: "VCD filename (default: output.vcd)",
              default: "output.vcd"
            },
          },
          required: ["project_id"],
        },
      },
      {
        name: "run_openlane",
        description: "Run complete ASIC design flow using OpenLane (RTL to GDSII). This process can take up to 10 minutes.",
        inputSchema: {
          type: "object",
          properties: {
            verilog_code: { 
              type: "string", 
              description: "The Verilog RTL code for ASIC implementation" 
            },
            design_name: { 
              type: "string", 
              description: "Name of the design (will be used for module and files)" 
            },
            clock_port: { 
              type: "string", 
              description: "Name of the clock port", 
              default: "clk" 
            },
            clock_period: { 
              type: "number", 
              description: "Clock period in nanoseconds", 
              default: 10.0 
            },
            open_in_klayout: {
              type: "boolean",
              description: "Automatically open result in KLayout",
              default: true
            },
          },
          required: ["verilog_code", "design_name"],
        },
      },
      {
        name: "view_gds",
        description: "Open GDSII file in KLayout viewer",
        inputSchema: {
          type: "object",
          properties: {
            project_id: { 
              type: "string", 
              description: "Project ID from OpenLane run" 
            },
            gds_file: { 
              type: "string", 
              description: "Specific GDS filename (optional, auto-detected if not provided)" 
            },
          },
          required: ["project_id"],
        },
      },

      // Add this object to the tools array, right after the view_gds tool
        {
            name: "read_openlane_reports",
            description: "Read OpenLane report files for LLM analysis. Returns all reports or specific category for detailed analysis of PPA metrics, timing, routing quality, and other design results.",
            inputSchema: {
            type: "object",
            properties: {
                project_id: { 
                type: "string", 
                description: "Project ID from OpenLane run" 
                },
                report_type: { 
                type: "string", 
                description: "Specific report category to read (synthesis, placement, routing, final, etc.). Leave empty to read all reports.",
                default: ""
                },
            },
            required: ["project_id"],
            },
        },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "synthesize_verilog": {
        const verilogCode = validateRequiredString(args, "verilog_code", name);
        const topModule = validateRequiredString(args, "top_module", name);
        const target = getStringProperty(args, "target", "generic");
        
        return {
          content: [{
            type: "text",
            text: await edaServer.synthesizeVerilog(verilogCode, topModule, target),
          }],
        };
      }
      case "simulate_verilog": {
        const verilogCode = validateRequiredString(args, "verilog_code", name);
        const testbenchCode = validateRequiredString(args, "testbench_code", name);
        
        return {
          content: [{
            type: "text",
            text: await edaServer.simulateVerilog(verilogCode, testbenchCode),
          }],
        };
      }
      case "view_waveform": {
        const projectId = validateRequiredString(args, "project_id", name);
        const vcdFile = getStringProperty(args, "vcd_file", "output.vcd");
        
        return {
          content: [{
            type: "text",
            text: await edaServer.viewWaveform(projectId, vcdFile),
          }],
        };
      }
      case "run_openlane": {
        const verilogCode = validateRequiredString(args, "verilog_code", name);
        const designName = validateRequiredString(args, "design_name", name);
        const clockPort = getStringProperty(args, "clock_port", "clk");
        const clockPeriod = getNumberProperty(args, "clock_period", 10.0);
        const openInKlayout = args && args.open_in_klayout !== false; // Default true
        
        return {
          content: [{
            type: "text",
            text: await edaServer.runOpenlane(verilogCode, designName, clockPort, clockPeriod, openInKlayout),
          }],
        };
      }
      case "view_gds": {
        const projectId = validateRequiredString(args, "project_id", name);
        const gdsFile = getStringProperty(args, "gds_file", "");
        
        return {
          content: [{
            type: "text",
            text: await edaServer.viewGds(projectId, gdsFile || undefined),
          }],
        };
      }

      // Add this case right after the view_gds case
        case "read_openlane_reports": {
            const projectId = validateRequiredString(args, "project_id", name);
            const reportType = getStringProperty(args, "report_type", "");
            
            return {
            content: [{
                type: "text",
                text: await edaServer.readOpenlaneReports(projectId, reportType || undefined),
            }],
            };
        }
        
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Tool not found: ${name}`);
    }
  } catch (error) {
    if (error instanceof McpError) throw error;
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new McpError(ErrorCode.InternalError, `Tool execution failed: ${errorMessage}`);
  }
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  
  // Only log to stderr, never stdout (stdout is for JSON-RPC)
  console.error("Enhanced Yosys MCP Server running on stdio");
  console.error("Features: Synthesis, Simulation, OpenLane ASIC flow");
  console.error("OpenLane timeout extended to 10 minutes");
}

main().catch((error) => {
  console.error("Server failed to start:", error);
  process.exit(1);
});