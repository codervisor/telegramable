import * as launchd from "./launchd";
import * as systemd from "./systemd";

type ServiceManager = {
  install: () => void;
  uninstall: () => void;
  start: () => void;
  stop: () => void;
  restart: () => void;
  status: () => void;
};

function getManager(): ServiceManager {
  if (process.platform === "darwin") {
    return launchd;
  }
  if (process.platform === "linux") {
    return systemd;
  }
  throw new Error(`Unsupported platform for service management: ${process.platform}. Use 'telegramable start' to run in foreground.`);
}

export const serviceManager: ServiceManager = {
  install: () => getManager().install(),
  uninstall: () => getManager().uninstall(),
  start: () => getManager().start(),
  stop: () => getManager().stop(),
  restart: () => getManager().restart(),
  status: () => getManager().status(),
};
