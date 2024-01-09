{ repoRoot, inputs, pkgs, lib, system }:

lib.iogx.mkShell {

  name = "ts-sdk";

  packages = [
    pkgs.pkg-config
    pkgs.deno
    pkgs.scriv
    pkgs.nodePackages.nodejs
    pkgs.nodePackages.prettier
    pkgs.nodePackages.prettier-plugin-toml
    inputs.marlowe-spec.packages.marlowe-spec
  ];

  scripts.build-changelog = {
    description = "Makes a changelog release from the changelog.d fragments";
    group = "ts-sdk";
    exec = ''
      VERSION=$(jq ".version" package.json)
      echo "Writting changelog for version $VERSION"
      scriv collect --version "$VERSION"
    '';
  };

  scripts.test-spec =
    let
      marlowe-spec-program = pkgs.writeShellApplication {
        name = "marlowe-spec-program";
        runtimeInputs = [ pkgs.nodePackages.nodejs ];
        text = ''
          node packages/language/specification-client/dist/esm/main.js
        '';
      };
    in
    {
      group = "ts-sdk";
      description = "Runs the Marlowe Spec test suite";
      exec = "marlowe-spec -c ${lib.getExe marlowe-spec-program}";
    };


  # NOTE: jsdelivr-npm-importmap.js is generated by 'npm run build' and causes
  # formatting issues in CI, hence why we exclude it from the formatting checks.
  preCommit = {
    shellcheck.enable = true;
    nixpkgs-fmt.enable = true;

    editorconfig-checker.enable = true;
    editorconfig-checker.excludes = [ "jsdelivr-npm-importmap\\.js" ];

    prettier.enable = true;
    prettier.extraOptions = "--plugin ${pkgs.nodePackages.prettier-plugin-toml}/lib/node_modules/prettier-plugin-toml/lib/api.js --write";
    prettier.excludes = [ "jsdelivr-npm-importmap\\.js" ];
  };
}

