class Mors < Formula
  desc "Agent-to-agent encrypted messaging CLI with E2EE relay and sandbox bridge"
  homepage "https://github.com/jstxn/mors"
  # Install from this project's own GitHub source. The npm name "mors" is owned
  # by an unrelated package, so the formula must NOT fetch from the npm registry.
  url "https://github.com/jstxn/mors/archive/refs/tags/v0.1.0.tar.gz"
  # Placeholder — replace with the real digest once the v0.1.0 tag is published:
  #   curl -sL https://github.com/jstxn/mors/archive/refs/tags/v0.1.0.tar.gz | shasum -a 256
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"
  license "UNLICENSED"
  head "https://github.com/jstxn/mors.git", branch: "main"

  depends_on "node"
  depends_on "sqlcipher"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink libexec.glob("bin/*")
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/mors --version")
  end
end
