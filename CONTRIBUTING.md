# Contributing to WOPR

Thank you for your interest in contributing to WOPR! This document provides guidelines for contributing.

## Code of Conduct

This project adheres to a code of conduct. By participating, you are expected to uphold this code:

- Be respectful and inclusive
- Welcome newcomers
- Focus on constructive feedback
- Respect different viewpoints and experiences

## How to Contribute

### Reporting Bugs

Before creating an issue:
- Check if the bug is already reported
- Try the latest version
- Collect relevant information (logs, versions, OS)

When reporting:
1. Use a clear, descriptive title
2. Describe the steps to reproduce
3. Include expected vs actual behavior
4. Provide environment details:
   - WOPR version: `wopr --version`
   - Node.js version: `node --version`
   - Operating system
   - Relevant configuration
5. Include logs: `wopr daemon logs`

### Suggesting Features

Feature requests are welcome! Please:
- Check if the feature is already requested
- Explain the use case
- Describe the desired behavior
- Consider implementation complexity

### Pull Requests

1. **Fork the repository**
2. **Create a branch**: `git checkout -b feature/my-feature`
3. **Make your changes**
4. **Test your changes**
5. **Update documentation** if needed
6. **Commit with clear messages**
7. **Push to your fork**
8. **Open a Pull Request**

#### Commit Message Format

```
type(scope): subject

body (optional)

footer (optional)
```

Types:
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `style`: Code style (formatting, semicolons)
- `refactor`: Code refactoring
- `test`: Adding/updating tests
- `chore`: Build process, dependencies

Examples:
```
feat(daemon): Add WebSocket support

fix(sessions): Handle empty context correctly
docs(readme): Update installation instructions
```

### Development Setup

```bash
# Clone repository
git clone https://github.com/TSavo/wopr.git
cd wopr

# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test

# Start daemon in dev mode
npm run dev
```

### Project Structure

```
wopr/
├── src/
│   ├── commands/     # CLI commands
│   ├── core/         # Core functionality
│   ├── daemon/       # HTTP daemon
│   └── types.ts      # TypeScript definitions
├── docs/             # Documentation
├── examples/         # Example plugins
└── tests/            # Test files
```

### Coding Standards

- **TypeScript**: All new code in TypeScript
- **ESLint**: Follow existing lint rules
- **Testing**: Add tests for new features
- **Documentation**: Update docs for API changes
- **Comments**: Explain complex logic

### Plugin Development

See [docs/PLUGINS.md](docs/PLUGINS.md) for plugin development guide.

To contribute a plugin:
1. Create a separate repository
2. Follow naming convention: `wopr-plugin-<name>`
3. Include README with setup instructions
4. Add to the official plugins list

### Documentation

Documentation improvements are always welcome:
- Fix typos
- Clarify explanations
- Add examples
- Update outdated information

## Review Process

Pull requests will be reviewed by maintainers. Please:
- Respond to feedback promptly
- Be open to suggestions
- Keep discussions focused
- Update your PR as needed

## Release Process

WOPR follows semantic versioning:
- **MAJOR**: Breaking changes
- **MINOR**: New features (backward compatible)
- **PATCH**: Bug fixes

Releases are tagged with Git tags.

## Getting Help

- **Discord**: [WOPR Community](https://discord.gg/wopr) (if available)
- **GitHub Issues**: For bugs and features
- **GitHub Discussions**: For questions and ideas

## License

By contributing, you agree that your contributions will be licensed under the MIT License.

## Recognition

Contributors will be recognized in:
- Release notes
- CONTRIBUTORS.md (major contributions)
- Git history

Thank you for contributing to WOPR!
